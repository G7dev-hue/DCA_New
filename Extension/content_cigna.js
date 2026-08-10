if (typeof document === "undefined" || globalThis.location?.protocol === "moz-extension:") {
    // Service-worker half of this same file. Cigna API calls must originate from
    // the extension to use host permissions and avoid page CORS restrictions.
    const CIGNA_ORIGIN = "https://p-chcp.digitaledge.cigna.com";
    const CIGNA_SESSION_ERROR = "Cigna API session was not captured. Open or reload the Dental Coverage page while signed in, then run the crawl again.";
    const cignaSessions = new Map();
    const descriptionCache = new Map();

    chrome.webRequest.onBeforeSendHeaders.addListener(details => {
        if (details.tabId < 0) return;
        let url;
        try { url = new URL(details.url); } catch (_) { return; }
        const match = url.pathname.match(/^\/patient\/dental\/v2\/benefits\/([^/]+)\/(?:coverage-and-benefits|dental-benefits)$/);
        if (!match) return;
        const authorization = (details.requestHeaders || []).find(header => header.name.toLowerCase() === "authorization")?.value;
        if (!authorization) return;
        const previous = cignaSessions.get(details.tabId) || {};
        cignaSessions.set(details.tabId, {
            authorization,
            contextId: decodeURIComponent(match[1]),
            consumerCode: url.searchParams.get("consumerCode") || previous.consumerCode,
            asof: url.searchParams.get("asof") || previous.asof,
            capturedAt: Date.now()
        });
        chrome.storage.session.set({ [`cigna_session_${details.tabId}`]: cignaSessions.get(details.tabId) });
    }, { urls: [`${CIGNA_ORIGIN}/*`] },
    typeof browser === "undefined" ? ["requestHeaders", "extraHeaders"] : ["requestHeaders"]);

    async function requireSession(tabId) {
        let session = cignaSessions.get(tabId);
        if (!session) {
            const key = `cigna_session_${tabId}`;
            session = (await chrome.storage.session.get(key))[key];
            if (session) cignaSessions.set(tabId, session);
        }
        if (!session?.authorization || !session.contextId || !session.consumerCode || !session.asof) throw new Error(CIGNA_SESSION_ERROR);
        return session;
    }

    async function workerCignaApi(tabId, action, payload) {
        const session = await requireSession(tabId);
        if (action === "session") return { captured: true };
        let url;
        const options = { credentials: "include", headers: { accept: "application/json, text/plain, */*", authorization: session.authorization } };
        if (action === "coverage") {
            url = new URL(`${CIGNA_ORIGIN}/patient/dental/v2/benefits/${encodeURIComponent(session.contextId)}/coverage-and-benefits`);
            url.search = new URLSearchParams({ consumerCode: session.consumerCode, asof: session.asof });
        } else if (action === "description") {
            const cacheKey = `${session.asof}:${payload.code}`;
            if (descriptionCache.has(cacheKey)) return descriptionCache.get(cacheKey);
            url = new URL(`${CIGNA_ORIGIN}/search/v2/codes/procedures`);
            url.search = new URLSearchParams({ consumerCode: session.consumerCode, search: payload.code, asof: session.asof, claimSystem: "DNTC" });
        } else if (action === "benefits") {
            url = new URL(`${CIGNA_ORIGIN}/patient/dental/v2/benefits/${encodeURIComponent(session.contextId)}/dental-benefits`);
            url.search = new URLSearchParams({ consumerCode: session.consumerCode, asof: session.asof, coverage: "DENT" });
            options.method = "POST";
            options.headers["content-type"] = "application/json";
            options.body = JSON.stringify({ procedures: (payload.procedures || []).map(item => ({
                code: item.code, tooth: item.tooth || "", arch: item.arch || "", quadrant: item.quadrant || "", desc: item.desc || ""
            })) });
        } else throw new Error("Unsupported Cigna API operation.");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        let response;
        try { response = await fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); }
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                cignaSessions.delete(tabId);
                chrome.storage.session.remove(`cigna_session_${tabId}`);
            }
            const retryAfter = response.headers.get("retry-after");
            const error = new Error(response.status === 401 || response.status === 403 ? CIGNA_SESSION_ERROR : "Cigna API request failed.");
            error.status = response.status;
            error.retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
            error.retryable = response.status === 429 || response.status >= 500;
            throw error;
        }
        const data = await response.json();
        if (action === "description") {
            const exact = (data.matches || []).find(item => item.code === payload.code);
            const result = { description: exact?.longDesc || exact?.shortDesc || "" };
            descriptionCache.set(`${session.asof}:${payload.code}`, result);
            return result;
        }
        return data;
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.command === "CIGNA_CLEAR_SESSION") {
            const tabId = sender.tab?.id;
            cignaSessions.delete(tabId);
            descriptionCache.clear();
            chrome.storage.session.remove(`cigna_session_${tabId}`, () => sendResponse({ ok: true }));
            return true;
        }
        if (request?.command !== "CIGNA_API") return;
        workerCignaApi(sender.tab?.id, request.action, request.payload || {})
            .then(data => sendResponse({ ok: true, data }))
            .catch(error => sendResponse({ ok: false, error: error.message, status: error.status || 0, retryAfterMs: error.retryAfterMs || 0, retryable: Boolean(error.retryable) }));
        return true;
    });
    chrome.tabs.onRemoved.addListener(tabId => {
        cignaSessions.delete(tabId);
        chrome.storage.session.remove(`cigna_session_${tabId}`);
    });
} else if (!globalThis.chrome?.runtime?.id) {
    // MAIN-world half of this file. It starts at document_start so it can retain
    // the authenticated Cigna request context without an extension background.
    (() => {
        const BRIDGE_CHANNEL = "insurance-auditor-cigna-v2";
        if (window.__insuranceAuditorCignaBridgeV2) return;
        window.__insuranceAuditorCignaBridgeV2 = true;
        const API_ORIGIN = "https://p-chcp.digitaledge.cigna.com";
        let session = null;

        const bearerFromValue = value => {
            const text = String(value || "");
            const bearer = text.match(/Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i)?.[0];
            if (bearer) return bearer;
            const jwt = text.match(/(?:access[_-]?token["']?\s*[:=]\s*["']?)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i)?.[1];
            return jwt ? `Bearer ${jwt}` : "";
        };

        function recoverSession() {
            let recovered = session ? { ...session } : {};
            for (const entry of performance.getEntriesByType("resource")) {
                let url;
                try { url = new URL(entry.name); } catch (_) { continue; }
                const match = url.pathname.match(/^\/patient\/dental\/v2\/benefits\/([^/]+)\/(?:coverage-and-benefits|dental-benefits)$/);
                if (!match) continue;
                recovered.contextId = decodeURIComponent(match[1]);
                recovered.consumerCode = url.searchParams.get("consumerCode") || recovered.consumerCode;
                recovered.asof = url.searchParams.get("asof") || recovered.asof;
            }
            if (!recovered.authorization) {
                for (const storage of [sessionStorage, localStorage]) {
                    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
                        .sort((a, b) => Number(/access|bearer/i.test(b)) - Number(/access|bearer/i.test(a)));
                    for (const key of keys) {
                        const authorization = bearerFromValue(storage.getItem(key));
                        if (authorization) { recovered.authorization = authorization; break; }
                    }
                    if (recovered.authorization) break;
                }
            }
            if (recovered.authorization || recovered.contextId) session = { ...recovered, capturedAt: recovered.capturedAt || Date.now() };
            return session;
        }

        const capture = (input, init = {}) => {
            let url, headers;
            try {
                const request = input instanceof Request ? input : null;
                url = new URL(request?.url || String(input), location.href);
                headers = new Headers(init.headers || request?.headers || {});
            } catch (_) { return; }
            const match = url.pathname.match(/^\/patient\/dental\/v2\/benefits\/([^/]+)\/(?:coverage-and-benefits|dental-benefits)$/);
            if (!match) return;
            const authorization = headers.get("authorization");
            if (!authorization) return;
            session = {
                authorization, contextId: decodeURIComponent(match[1]),
                consumerCode: url.searchParams.get("consumerCode") || session?.consumerCode,
                asof: url.searchParams.get("asof") || session?.asof,
                capturedAt: Date.now()
            };
        };

        const nativeFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
            capture(input, init);
            return nativeFetch(input, init);
        };
        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const nativeSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this.__auditorRequest = { method, url, headers: {} };
            return nativeOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (this.__auditorRequest) this.__auditorRequest.headers[name] = value;
            return nativeSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
            const request = this.__auditorRequest;
            if (request) capture(request.url, { headers: request.headers });
            return nativeSend.apply(this, arguments);
        };

        function pageRequest(url, options) {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                nativeOpen.call(xhr, options.method || "GET", String(url), true);
                xhr.withCredentials = true;
                xhr.timeout = 25000;
                for (const [name, value] of Object.entries(options.headers || {})) nativeSetHeader.call(xhr, name, value);
                xhr.onload = () => resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                    retryAfter: xhr.getResponseHeader("retry-after"),
                    json: () => JSON.parse(xhr.responseText)
                });
                xhr.onerror = () => reject(new Error("Cigna API network request failed. The portal blocked the request before returning an HTTP response."));
                xhr.ontimeout = () => reject(new Error("Cigna API request timed out."));
                xhr.onabort = () => reject(new Error("Cigna API request was aborted."));
                nativeSend.call(xhr, options.body || null);
            });
        }

        async function callApi(action, payload) {
            recoverSession();
            if (!session?.authorization || !session.contextId || !session.consumerCode || !session.asof)
                throw new Error("Cigna API session is not ready. Open the patient's Dental Coverage page, wait for it to finish loading, then run the crawl.");
            let url;
            const options = { credentials: "include", headers: { accept: "application/json, text/plain, */*", authorization: session.authorization } };
            if (action === "session") return { captured: true };
            if (action === "coverage") {
                url = new URL(`${API_ORIGIN}/patient/dental/v2/benefits/${encodeURIComponent(session.contextId)}/coverage-and-benefits`);
                url.search = new URLSearchParams({ consumerCode: session.consumerCode, asof: session.asof });
            } else if (action === "description") {
                url = new URL(`${API_ORIGIN}/search/v2/codes/procedures`);
                url.search = new URLSearchParams({ consumerCode: session.consumerCode, search: payload.code, asof: session.asof, claimSystem: "DNTC" });
            } else if (action === "benefits") {
                url = new URL(`${API_ORIGIN}/patient/dental/v2/benefits/${encodeURIComponent(session.contextId)}/dental-benefits`);
                url.search = new URLSearchParams({ consumerCode: session.consumerCode, asof: session.asof, coverage: "DENT" });
                options.method = "POST";
                options.headers["content-type"] = "application/json";
                options.body = JSON.stringify({ procedures: (payload.procedures || []).map(item => ({
                    code: item.code, tooth: item.tooth || "", arch: item.arch || "", quadrant: item.quadrant || "", desc: item.desc || ""
                })) });
            } else throw new Error("Unsupported Cigna API operation.");
            const response = await pageRequest(url, options);
            if (!response.ok) {
                const error = new Error(response.status === 401 || response.status === 403
                    ? "Cigna session expired. Reopen the Dental Coverage page and try again."
                    : "Cigna API request failed.");
                error.status = response.status;
                error.retryable = response.status === 429 || response.status >= 500;
                const retryAfter = response.retryAfter;
                error.retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
                throw error;
            }
            const data = response.json();
            if (action === "description") {
                const exact = (data.matches || []).find(item => item.code === payload.code);
                return { description: exact?.longDesc || exact?.shortDesc || "" };
            }
            return data;
        }

        window.addEventListener("message", event => {
            if (event.source !== window || event.data?.source !== BRIDGE_CHANNEL || event.data?.type !== "request") return;
            const { id, action, payload } = event.data;
            callApi(action, payload || {}).then(data => window.postMessage({ source: BRIDGE_CHANNEL, type: "response", id, ok: true, data }, "*"))
                .catch(error => window.postMessage({ source: BRIDGE_CHANNEL, type: "response", id, ok: false, error: error.message, status: error.status || 0, retryAfterMs: error.retryAfterMs || 0, retryable: Boolean(error.retryable) }, "*"));
        });
    })();
} else {
const clean = (s) => (s || "").trim().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getVal = (selector) => document.querySelector(`[data-test-id="${selector}"]`)?.innerText?.trim() || "N/A";

// ── Code lists ─────────────────────────────────────────────────────────────
const PROCEDURE_CODES = [
    "D0180", "D0120", "D0140", "D0150","D1208",
    "D0210", "D0220", "D0230", "D0240", "D0274", "D0330", "D0364", "D0431",
    "D1510", "D1110", "D1120", "D1206", "D1351",
    "D2140", "D2331", "D2391", "D2620", "D2740", "D2950", "D2962", "D2991",
    "D3347", "D3310", "D3330",
    "D4260", "D4249", "D4341", "D4355", "D4381", "D4346", "D4910",
    "D5860", "D5110", "D5740", "D5982",
    "D6194", "D6010", "D6056", "D6065",
    "D6245", "D6750",
    "D7259", "D7140", "D7210", "D7240", "D7953",
    "D8010", "D8080", "D8090",
    "D9430", "D9110", "D9222", "D9230", "D9239", "D9243", "D9310", "D9944"
];

const CIGNA_VALID_CONTEXT_VALUES = {
    tooth: [
        ...Array.from({ length: 32 }, (_, index) => String(index + 1)),
        ...Array.from({ length: 32 }, (_, index) => String(index + 51)),
        ..."ABCDEFGHIJKLMNOPQRST".split("").map(letter => `${letter}S`),
        ..."ABCDEFGHIJKLMNOPQRST".split("")
    ],
    arch: ["UA", "LA"],
    quadrant: ["LR", "LL", "UR", "UL"]
};
const CIGNA_DEFAULT_CONTEXT = { tooth: "3", arch: "UA", quadrant: "LR" };
// Do not infer "number of payable D4341 quads" from context probes. A single
// quadrant response only proves that context is valid for coverage lookup.
const CIGNA_ALL_QUADRANT_CONTEXT_CODES = new Set([]);
const CIGNA_CONTEXT_BY_CODE = {
    D1351: { tooth: "3" },
    D1510: { quadrant: "LR" },
    D2140: { tooth: "3" },
    D2331: { tooth: "8" },
    D2391: { tooth: "3" },
    D2620: { tooth: "3" },
    D2740: { tooth: "3" },
    D2950: { tooth: "3" },
    D2962: { tooth: "8" },
    D2991: { tooth: "3" },
    D3347: { tooth: "4" },
    D3310: { tooth: "8" },
    D3330: { tooth: "3" },
    D4260: { quadrant: "LR" },
    D4249: { tooth: "3" },
    D4341: { quadrant: "LR" },
    D4381: { tooth: "3" },
    D5860: { arch: "UA" },
    D5110: { arch: "UA" },
    D5740: { arch: "UA" },
    D5982: { arch: "UA" },
    D6194: { tooth: "3" },
    D6010: { tooth: "3" },
    D6056: { tooth: "3" },
    D6065: { tooth: "3" },
    D6245: { tooth: "3" },
    D6750: { tooth: "3" },
    D7259: { tooth: "17" },
    D7140: { tooth: "3" },
    D7210: { tooth: "3" },
    D7240: { tooth: "17" },
    D7953: { tooth: "3" }
};
const CIGNA_CONTEXT_VARIANTS_BY_CODE = {
    D1351: [
        { tooth: "3", _context_reason: "permanent_molar_test" },
        { tooth: "8", _context_reason: "permanent_non_molar_test" }
    ],
    /*
    D4341 all-quadrant probing is intentionally disabled. It can show which
    queried quadrants return coverage, but it does not prove the plan's
    same-visit or maximum payable quadrant rule.
    D4341: [
        { quadrant: "LR", _context_reason: "all_quadrants_test" },
        { quadrant: "LL", _context_reason: "all_quadrants_test" },
        { quadrant: "UR", _context_reason: "all_quadrants_test" },
        { quadrant: "UL", _context_reason: "all_quadrants_test" }
    ]
    */
};
const CIGNA_FORCED_CONTEXT_CODES = new Set(Object.keys(CIGNA_CONTEXT_VARIANTS_BY_CODE));

// ══════════════════════════════════════════════════════════════════════════
// PAGE LOCK
// ══════════════════════════════════════════════════════════════════════════

let _overlay = null;
let activeCignaRun = null;
let _lastStatusAt = 0;
function lockPage() {
    if (_overlay) return;
    _overlay = document.createElement('div');
    Object.assign(_overlay.style, {
        position:'fixed', top:'0', left:'0', width:'100vw', height:'100vh',
        zIndex:'2147483647', background:'rgba(0,0,0,0.22)', cursor:'not-allowed',
        display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'all', userSelect:'none',
    });
    _overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:28px 36px;
            box-shadow:0 4px 32px rgba(0,0,0,0.2);text-align:center;font-family:sans-serif;">
            <div style="font-size:22px;font-weight:700;color:#003087;margin-bottom:8px;">🔄 Cigna Crawl Running…</div>
            <div id="_cigna_status" style="font-size:14px;color:#555;">
                Please wait — do not scroll, click, or navigate.<br>
                The page will unlock automatically when done.
            </div>
        </div>`;
    ['click','mousedown','mouseup','touchstart','touchend','keydown','keyup','scroll','wheel']
        .forEach(e => _overlay.addEventListener(e, ev => ev.stopImmediatePropagation(), true));
    document.body.appendChild(_overlay);
    document.body.style.overflow = 'hidden';
}
function setStatus(msg) {
    const el = document.getElementById('_cigna_status');
    if (el) el.innerHTML = msg;
    console.log('Cigna:', msg);
}
function unlockPage() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function findByText(text, root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode()))
        if (node.textContent.trim() === text) return node.parentElement;
    return null;
}
function findByPartialText(text, tags = ['button','a','span','div']) {
    for (const tag of tags) {
        const found = Array.from(document.querySelectorAll(tag))
            .find(el => el.innerText?.trim().includes(text) && el.children.length <= 2);
        if (found) return found;
    }
    return null;
}
async function waitFor(fn, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const r = fn(); if (r) return r; await sleep(200); }
    return null;
}
// ══════════════════════════════════════════════════════════════════════════
// PAGE SCRAPE — static data
// ══════════════════════════════════════════════════════════════════════════

// ── REPLACE parseCignaAmount ───────────────────────────────────────────────
function parseCignaAmount(text) {
    if (!text) return { remaining: "N/A", total: "N/A" };

    const isMet = /met\b/i.test(text);

    // extract all dollar amounts in order
    const amounts = [...text.matchAll(/\$\s*([\d,]+\.?\d*)/g)]
        .map(m => '$' + m[1].replace(/,/g, ''));

    // "Total:" line
    const totalM = text.match(/Total[:\s]+\$([\d,]+\.?\d*)/i);
    const total  = totalM ? '$' + totalM[1].replace(/,/g, '') : (amounts[amounts.length - 1] || "N/A");

    // remaining: if "Met" → $0.00, else first amount before Total
    let remaining;
    if (isMet) {
        remaining = "$0.00";
    } else {
        // first amount that isn't the total amount
        remaining = amounts.find(a => a !== total) || amounts[0] || "N/A";
    }

    return { remaining, total };
}

function scrapePatientDOB() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (node.textContent.trim() === 'Date of Birth') {
            const sib = node.parentElement?.nextElementSibling;
            if (sib) { const t = sib.innerText?.trim(); if (/\d{2}\/\d{2}\/\d{4}/.test(t)) return t; }
            const row = node.parentElement?.closest('tr,[class*="row"],li,div');
            if (row) { const m = row.innerText.match(/\d{2}\/\d{2}\/\d{4}/); if (m) return m[0]; }
        }
    }
    const m = document.body.innerText.match(/Date of Birth[\s\S]{0,40}?(\d{2}\/\d{2}\/\d{4})/);
    return m ? m[1] : null;
}

function scrapeCignaFull() {
    const data = {
        source: "Cigna Portal",
        timestamp: new Date().toISOString(),
        summary: {
            patient_id:   document.body.innerText.match(/Patient ID:\s*(.*)/)?.[1]?.trim() || "N/A",
            group_number: document.body.innerText.match(/Group Number:\s*(\d+)/)?.[1] || "N/A",
            group_name:   getVal("account-name") || "N/A",
            plan_type:    getVal("plan-type") || "N/A",
            coverage_dates: {
                from: document.body.innerText.match(/Coverage From:\s*([\d\/]+)/)?.[1] || "N/A",
                to:   document.body.innerText.match(/Coverage To:\s*(.*)/)?.[1]?.trim() || "N/A"
            }
        },
        patient: {
            name:         document.body.innerText.match(/^Name\s+([^\n]+)/m)?.[1]?.trim() || "N/A",
            dob:          scrapePatientDOB() || "N/A",
            gender:       document.body.innerText.match(/Gender\s+([^\n]+)/)?.[1]?.trim() || "N/A",
            relationship: document.body.innerText.match(/Relationship\s+([^\n]+)/)?.[1]?.trim() || "N/A",
        },
        // ── REPLACE financials inside scrapeCignaFull ─────────────────────────────
    financials: (() => {
    // ── Deductible card ───────────────────────────────────────────────
        const dedBox = document.querySelector('.deductible-box') ||
        (() => {
            const h = Array.from(document.querySelectorAll('h2,h3,[class*="title"],[class*="header"]'))
                .find(el => /deductible/i.test(el.innerText) && !/family/i.test(el.innerText));
            return h?.closest('[class*="card"],[class*="box"],[class*="panel"],section,div[class]');
        })();

    // individual deductible sub-section (left column)
        const dedIndText = (() => {
            if (!dedBox) return '';
        // look for the "Individual Calendar Year" sub-section only
            const walker = document.createTreeWalker(dedBox, NodeFilter.SHOW_TEXT, null, false);
            let node, capture = false, lines = [];
            while ((node = walker.nextNode())) {
                const t = node.textContent.trim();
                if (/individual calendar year deductible/i.test(t)) { capture = true; continue; }
                if (capture && /family calendar year/i.test(t)) break;
                if (capture && t) lines.push(t);
            }
            return lines.join('\n');
        })();
        const deductible_ind = parseCignaAmount(dedIndText || dedBox?.innerText || '');

    // ── Benefit Maximums card ─────────────────────────────────────────
        const maxCard = (() => {
            const h = Array.from(document.querySelectorAll('h2,h3,[class*="title"],[class*="header"]'))
                .find(el => /benefit maximums?/i.test(el.innerText));
            return h?.closest('[class*="card"],[class*="box"],[class*="panel"],section,div[class]') ||
               document.querySelector('.oop-box');
        })();

        const maxCardText = maxCard?.innerText || '';

    // split annual vs ortho within the card
        const orthoSplit = maxCardText.search(/\bOrthodontics\b/i);
        const annualText = orthoSplit > -1 ? maxCardText.slice(0, orthoSplit) : maxCardText;
        const orthoText  = orthoSplit > -1 ? maxCardText.slice(orthoSplit)    : '';
        const annual_max     = parseCignaAmount(annualText);
        const ortho_lifetime = parseCignaAmount(orthoText);

        return { annual_max, deductible_ind, ortho_lifetime };
    })(),
        coinsurance: Array.from(document.querySelectorAll('[data-test-id^="table-row-"]')).map(row => ({
            category:     row.querySelector('th')?.innerText?.replace('*', '').trim() || "N/A",
            patient_pays: row.querySelector('td')?.innerText?.trim() || "N/A"
        })),
        frequencies: Array.from(document.querySelectorAll('cigna-freq-age-limit table:first-of-type tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            return { procedure: clean(cells[1]?.innerText), limit: clean(cells[2]?.innerText) };
        }).filter(r => r.procedure),
        age_limits: Array.from(document.querySelectorAll('cigna-freq-age-limit table:last-of-type tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return null;
            return { type: clean(cells[0]?.innerText), age: clean(cells[1]?.innerText), ends: clean(cells[2]?.innerText) };
        }).filter(Boolean),
        notes: {
            missing_tooth: document.body.innerText.includes("Missing Tooth Limitation and Waiting Period does not apply")
                ? "Does not apply" : "Verify",
            ortho_note: getVal("lbl-age-limitations-note") || "N/A"
        },
        procedures: {
            age_gate: {},
            codes_searched: [],
            count: 0,
            results: []
        }
    };
    return data;
}

// ══════════════════════════════════════════════════════════════════════════
// AGE GATE
// ══════════════════════════════════════════════════════════════════════════

function readAgeLimitsFromPage() {
    const result = {};
    document.querySelectorAll('cigna-freq-age-limit table:first-of-type tbody tr').forEach(row => {
        const t = row.innerText || '';
        const m = t.match(/[Ee]xclude after age\s+(\d+)/i);
        if (m) {
            if (/[Ff]luoride/i.test(t)) result.fluoride = parseInt(m[1], 10);
            if (/[Ss]ealant/i.test(t))  result.sealant  = parseInt(m[1], 10);
        }
    });
    document.querySelectorAll('cigna-freq-age-limit table:last-of-type tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (/ortho/i.test(cells[0]?.innerText))
            result.ortho = clean(cells[1]?.innerText).toLowerCase() === 'none' ? null : parseInt(cells[1]?.innerText, 10);
    });
    if (!Object.keys(result).length) {
        const b = document.body.innerText;
        const fm = b.match(/[Ff]luoride[\s\S]{0,120}[Ee]xclude after age\s+(\d+)/);
        if (fm) result.fluoride = parseInt(fm[1], 10);
        const sm = b.match(/[Ss]ealant[\s\S]{0,120}[Ee]xclude after age\s+(\d+)/);
        if (sm) result.sealant  = parseInt(sm[1], 10);
        if (/[Oo]rtho Age Limitation[\s\S]{0,80}None/i.test(b)) result.ortho = null;
    }
    console.log('Cigna: Portal age limits:', result);
    return result;
}

function calcAge(dobStr) {
    let dob;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dobStr)) {
        const [m, d, y] = dobStr.split('/');
        dob = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) {
        dob = new Date(dobStr);
    } else return null;
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const mo = today.getMonth() - dob.getMonth();
    if (mo < 0 || (mo === 0 && today.getDate() < dob.getDate())) age--;
    return age;
}

function filterCodesByAge(ageLimits, patientDOB) {
    if (!patientDOB) { console.warn('Cigna: No DOB — including all age-gated codes'); return AGE_GATED_LIST; }
    const age = calcAge(patientDOB);
    if (age === null) { console.warn('Cigna: Cannot parse DOB'); return AGE_GATED_LIST; }
    console.log(`Cigna: Patient age = ${age}`);
    const allowed = [];
    for (const code of AGE_GATED_LIST) {
        const meta = AGE_GATED_META[code];
        let maxAge = meta.maxAge;
        if (code === 'D1206' || code === 'D1208') maxAge = ageLimits.fluoride ?? meta.maxAge;
        else if (code === 'D1351')                 maxAge = ageLimits.sealant  ?? meta.maxAge;
        else if (code === 'D8080') {
            if (ageLimits.ortho === null || ageLimits.ortho === undefined) {
                console.log(`Cigna: ${code} — Ortho limit=None → INCLUDE`); allowed.push(code); continue;
            }
            maxAge = ageLimits.ortho;
        }
        if (maxAge === null || maxAge === undefined || age < maxAge) {
            console.log(`Cigna: ${code} — age ${age} < ${maxAge} → INCLUDE`); allowed.push(code);
        } else {
            console.log(`Cigna: ${code} — age ${age} >= ${maxAge} → EXCLUDE ❌`);
        }
    }
    return allowed;
}

// ══════════════════════════════════════════════════════════════════════════
// ACCORDION HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function ensureAccordionOpen(labelText) {
    const all = Array.from(document.querySelectorAll(
        '[class*="collapsible"],[class*="accordion"],[class*="panel-header"],button,a'
    ));
    const header = all.find(el => el.innerText?.trim().includes(labelText));
    if (header) {
        const open = header.getAttribute('aria-expanded') === 'true' ||
                     header.classList.contains('expanded') || header.classList.contains('open');
        if (!open) { header.click(); await sleep(1500); }
        return true;
    }
    const link = findByText(labelText) || findByPartialText(labelText);
    if (link) { link.click(); await sleep(1500); return true; }
    return false;
}

// ══════════════════════════════════════════════════════════════════════════
// PROCEDURE INPUT HELPERS
// ══════════════════════════════════════════════════════════════════════════

function getProcedureSection() {
    return (
        document.querySelector('[class*="procedure-code-search"],[class*="ProcedureCodeSearch"]') ||
        (() => { const h = findByPartialText("Procedure Code Lookup"); return h?.closest('section,[class*="panel"],[class*="card"],div[class]'); })() ||
        (() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'Submit'); return b?.closest('section,[class*="panel"],div[class]'); })()
    );
}

function getAllProcedureInputs() {
    const root = getProcedureSection() || document.body;
    return Array.from(root.querySelectorAll('input[type="text"],input:not([type])')).filter(inp => {
        const ph = (inp.placeholder || '').toLowerCase();
        return !(ph.includes('1-32') || ph.includes('as-ts') || ph.includes('tooth') || ph.includes('51-82'));
    });
}

function findEmptyProcedureInput() {
    const inputs = getAllProcedureInputs();
    for (let i = inputs.length - 1; i >= 0; i--)
        if (!inputs[i].value || inputs[i].value.trim() === '') return inputs[i];
    return null;
}

// ══════════════════════════════════════════════════════════════════════════
// AUTOCOMPLETE
// ══════════════════════════════════════════════════════════════════════════

async function clickAutocompleteSuggestion(codeStr, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const s = (
            Array.from(document.querySelectorAll('mat-option')).find(el => el.innerText?.trim().startsWith(codeStr)) ||
            Array.from(document.querySelectorAll('[role="option"]')).find(el => el.innerText?.trim().startsWith(codeStr)) ||
            Array.from(document.querySelectorAll('[role="listbox"] li')).find(el => el.innerText?.trim().startsWith(codeStr)) ||
            Array.from(document.querySelectorAll('li,[class*="option"],[class*="suggestion"]'))
                .find(el => el.innerText?.trim().startsWith(codeStr) && el.offsetParent !== null)
        );
        if (s) {
            try { console.log(`Cigna: Autocomplete matched "${(s.innerText||'').trim()}" for ${codeStr}`); } catch (_) {}
            s.click(); await sleep(700); return true;
        }
        await sleep(200);
    }
    console.warn(`Cigna: No autocomplete for ${codeStr}`);
    return false;
}

// ══════════════════════════════════════════════════════════════════════════
// QUADRANT SELECTION
// ══════════════════════════════════════════════════════════════════════════

function getRowContainerForInput(inputEl) {
    let el = inputEl.parentElement;
    while (el && el !== document.body) {
        const selects = el.querySelectorAll('select, mat-select');
        const inputsInEl = el.querySelectorAll('input[type="text"],input:not([type])');
        if (selects.length >= 1 && inputsInEl.length <= 3) return el;
        el = el.parentElement;
    }
    return null;
}

async function selectQuadrantForInput(inputEl, quadrantCode, timeout = 9000) {
    console.log(`Cigna: Selecting quadrant "${quadrantCode}" scoped to input row...`);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const row = getRowContainerForInput(inputEl);
        if (!row) { await sleep(300); continue; }
        for (const sel of row.querySelectorAll('select')) {
            const hasQuadrantOptions = Array.from(sel.options).some(o => o.text.toUpperCase().startsWith('LR'));
            if (!hasQuadrantOptions) continue;
            const opt = Array.from(sel.options).find(o => o.text.toUpperCase().startsWith(quadrantCode));
            if (!opt) continue;
            if (sel.value === opt.value) { console.log(`Cigna: Quadrant already set ✓`); return true; }
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(500);
            console.log(`Cigna: Native quadrant → "${opt.text}" ✓`);
            return true;
        }
        const matSelects = Array.from(row.querySelectorAll('mat-select'));
        const qSel = matSelects[matSelects.length - 1];
        if (qSel) {
            const cur = qSel.querySelector('.mat-select-value-text')?.innerText?.trim() || '';
            if (cur.toUpperCase().startsWith(quadrantCode)) { console.log(`Cigna: Quadrant already "${cur}" ✓`); return true; }
            qSel.click(); await sleep(700);
            const opt = Array.from(document.querySelectorAll('mat-option,[role="option"]'))
                .find(o => o.innerText?.trim().toUpperCase().startsWith(quadrantCode) && o.offsetParent !== null);
            if (opt) { opt.click(); await sleep(600); console.log(`Cigna: mat-select quadrant → "${opt.innerText?.trim()}" ✓`); return true; }
            document.body.click(); await sleep(400);
        }
        await sleep(300);
    }
    console.warn(`Cigna: Could not select quadrant "${quadrantCode}"`);
    return false;
}

// ══════════════════════════════════════════════════════════════════════════
// ENTER BATCH + SUBMIT
// ══════════════════════════════════════════════════════════════════════════

async function clearExistingCodes() {
    const btn = findByText("Clear all Codes") || findByPartialText("Clear all Codes");
    if (btn) { btn.click(); await sleep(1200); }
}

async function enterBatch(codes) {
    console.log(`Cigna: Entering batch [${codes.join(', ')}]`);
    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        console.log(`Cigna: Searching code ${code} (${i + 1}/${codes.length})`);
        const input = await waitFor(() => {
            const inp = findEmptyProcedureInput();
            return (inp && inp.offsetParent !== null) ? inp : null;
        }, 10000);
        if (!input) { console.error(`Cigna: No empty input for ${code}`); continue; }
        setStatus(`Entering code ${i + 1}/${codes.length}: <b>${code}</b>`);
        await angularType(input, code);
        const selected = await clickAutocompleteSuggestion(code, 8000);
        if (!selected) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            await sleep(900);
        } else {
            await sleep(900);
        }
        if (!input.value?.trim()) {
            console.warn(`Cigna: ${code} — input still empty, retrying`);
            await angularType(input, code);
            await clickAutocompleteSuggestion(code, 5000);
            await sleep(900);
        }
        if (QUADRANT_CODES[code]) {
            await waitFor(() => {
                const row = getRowContainerForInput(input);
                if (!row) return false;
                return Array.from(row.querySelectorAll('select')).some(sel =>
                    Array.from(sel.options).some(o => o.text.toUpperCase().startsWith('LR'))
                );
            }, 6000);
            await sleep(400);
            await selectQuadrantForInput(input, QUADRANT_CODES[code], 9000);
        }

        // ── ADD THIS BLOCK ────────────────────────────────────────────
        if (TOOTH_CODES[code]) {
            const toothVal = TOOTH_CODES[code];
            const row = getRowContainerForInput(input);
            if (row) {
                const toothInput = Array.from(row.querySelectorAll('input[type="text"],input:not([type])'))
                    .find(inp => {
                        const ph = (inp.placeholder || '').toLowerCase();
                        return ph.includes('1-32') || ph.includes('as-ts') || ph.includes('tooth');
                    });
                if (toothInput) {
                    await angularType(toothInput, toothVal);
                    await sleep(500);
                    console.log(`Cigna: Tooth set to "${toothVal}" for ${code}`);
                } else {
                    console.warn(`Cigna: Tooth input not found for ${code}`);
                }
            }
        }
        // ── END ADD ───────────────────────────────────────────────────
        if (i < codes.length - 1) {
            await sleep(700);
            const addBtn = (
                findByText("Add Additional Code") ||
                findByPartialText("Add Additional Code", ['button', 'a', 'span']) ||
                Array.from(document.querySelectorAll('button')).find(b => /add.*additional.*code/i.test(b.innerText))
            );
            if (addBtn) {
                addBtn.click();
                const prevCount = getAllProcedureInputs().length;
                await waitFor(() => getAllProcedureInputs().length > prevCount, 6000);
                await sleep(700);
            }
        }
    }
    await sleep(800);
    const submitBtn = findByText("Submit") ||
        Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'Submit');
    if (!submitBtn) { console.error("Cigna: Submit not found"); return false; }
    setStatus("Submitting codes… waiting for results");
    submitBtn.click();
    await sleep(6000);
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// RESULT ROW DISCOVERY
// ══════════════════════════════════════════════════════════════════════════
// Strategy: after Submit, Cigna renders a list of result rows. Each row's
// FIRST child element contains only the D-code and procedure name (no dollar
// amounts, no Maximum/Frequency labels). We find those header-child elements,
// then take their parentElement as the actual row container.
//
// This avoids the old approach of scanning all elements for D-codes (which
// matched the input fields where we just typed the codes).
// ══════════════════════════════════════════════════════════════════════════

function findResultRows() {

    let resultsContainer = null;

    const editBtn = Array.from(document.querySelectorAll('button'))
        .find(b =>
            /Edit Codes/i.test(b.innerText) ||
            /Generate Benefit Reference/i.test(b.innerText)
        );

    if (editBtn) {
        let el = editBtn.parentElement;

        while (el && el !== document.body) {
            if (/\bD\d{4}\b/.test(el.innerText)) {
                resultsContainer = el;
                break;
            }
            el = el.parentElement;
        }
    }

    if (!resultsContainer) {
        resultsContainer = getProcedureSection() || document.body;
    }

    console.log(
        'Cigna: Results container:',
        resultsContainer?.tagName,
        resultsContainer?.className?.slice(0, 80)
    );

    // ─────────────────────────────────────────────
    // Find ALL potential D-code elements
    // ─────────────────────────────────────────────

    const candidates = Array.from(
        resultsContainer.querySelectorAll('*')
    ).filter(el => {

        if (el.tagName === 'INPUT') return false;

        const txt = clean(el.innerText || '');

        return /\bD\d{4}\b/.test(txt);
    });

    console.log(`Cigna: ${candidates.length} D-code candidates`);

    // ─────────────────────────────────────────────
    // Group by likely shared row parent
    // ─────────────────────────────────────────────

    const parentCounts = new Map();

    for (const el of candidates) {

        let row = el;

        // walk upward until a reasonable row container
        for (let i = 0; i < 5; i++) {

            if (!row.parentElement) break;

            row = row.parentElement;

            const txt = clean(row.innerText || '');

            // row should contain ONE D-code
            const matches = txt.match(/\bD\d{4}\b/g) || [];

            if (matches.length === 1) {
                parentCounts.set(
                    row,
                    (parentCounts.get(row) || 0) + 1
                );
            }
        }
    }

    // pick containers appearing most often
    const rows = Array.from(parentCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([row]) => row)
        .filter(row => {

            const txt = clean(row.innerText || '');

            return (
                /\bD\d{4}\b/.test(txt) &&
                txt.length > 20
            );
        });

    // dedupe nested rows
    const finalRows = [];

    for (const row of rows) {

        const alreadyNested = finalRows.some(existing =>
            existing.contains(row) || row.contains(existing)
        );

        if (!alreadyNested) {
            finalRows.push(row);
        }
    }

    console.log(`Cigna: Final rows identified = ${finalRows.length}`);

    return finalRows;
}

// ══════════════════════════════════════════════════════════════════════════
// ROW CHEVRON — shallowest [aria-expanded] inside a row element
// ══════════════════════════════════════════════════════════════════════════

function getRowChevron(rowEl) {
    const all = Array.from(rowEl.querySelectorAll('[aria-expanded]'));
    if (!all.length) return null;
    let best = all[0], minDepth = Infinity;
    for (const el of all) {
        let d = 0, node = el;
        while (node && node !== rowEl) { d++; node = node.parentElement; }
        if (d < minDepth) { minDepth = d; best = el; }
    }
    return best;
}

// ══════════════════════════════════════════════════════════════════════════
// SCRAPE ONE ROW — reads ONLY the given row element's innerText
// Uses landmark headings (Maximum / Frequency / Coinsurance / History**)
// to isolate each data section before extracting values.
// ══════════════════════════════════════════════════════════════════════════

function scrapeOneRow(rowEl) {
    const fullText = rowEl.innerText || '';
    const lines    = fullText.split('\n').map(l => l.trim()).filter(Boolean);

    // ── Procedure code ────────────────────────────────────────────────
    const code = lines.find(l => /^D\d{4}\b/.test(l))?.match(/^(D\d{4})/)?.[1];
    if (!code) return null;

     // ── Description — multiline, stops at first landmark ─────────────
    const codeLineIdx = lines.findIndex(l => /^D\d{4}\b/.test(l));
    const descLines   = [];
    for (let i = codeLineIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^(History\*{1,2}|Maximum|Frequency|Coinsurance|Quadrant|Alternate benefit|Not a covered service)/i.test(l)) break;
        if (/^\d{4}-\d{2}-\d{2}$/.test(l)) break;
        if (/^D\d{4}\b/.test(l)) break;
        descLines.push(l);
    }
    const description = clean(descLines.join(' ')) || 'N/A';

    // ── Covered status ────────────────────────────────────────────────
    const notCovered = /Not a covered service/i.test(fullText);

    // ── Landmark indices ──────────────────────────────────────────────
    const maxIdx   = lines.findIndex(l => /^Maximum$/i.test(l));
    const freqIdx  = lines.findIndex(l => /^Frequency$/i.test(l));
    const coinsIdx = lines.findIndex(l => /^Coinsurance$/i.test(l));
    const histIdx  = lines.findIndex(l => /^History\*{1,2}$/.test(l));

    function sliceBetween(start, end) {
        if (start === -1) return [];
        const to = (end === -1 || end === undefined) ? lines.length : end;
        return lines.slice(start + 1, to);
    }

    const maxLines   = sliceBetween(maxIdx,   freqIdx  !== -1 ? freqIdx  : coinsIdx !== -1 ? coinsIdx : histIdx);
    const freqLines  = sliceBetween(freqIdx,  coinsIdx !== -1 ? coinsIdx : histIdx  !== -1 ? histIdx  : lines.length);
    const coinsLines = sliceBetween(coinsIdx, histIdx  !== -1 ? histIdx  : lines.length);
    const histLines  = sliceBetween(histIdx,  lines.length);

    // ── Dollar amounts — Maximum section only ─────────────────────────
    const amtRx = /\$\s*([\d][\d\s,]*\.[\d]{2})/g;
    function extractAmounts(lineArr) {
        return [...lineArr.join(' ').matchAll(amtRx)].map(m => '$' + m[1].replace(/\s/g, ''));
    }

    const maxAmounts   = extractAmounts(maxLines);
    const indRemaining = maxAmounts[0] || 'N/A';
    const totalLine    = maxLines.find(l => /^Total[:\s]/i.test(l)) || '';
    const totalAmts    = extractAmounts([totalLine]);
    const maxTotal     = totalAmts[0] || maxAmounts[1] || 'N/A';

    // ── Frequency ─────────────────────────────────────────────────────
    const freqUsedLine  = freqLines.find(l => /\d+\s+of\s+\d+/i.test(l)) || '';
    const freqUsedM     = freqUsedLine.match(/(\d+)\s+of\s+(\d+)/i);
    const freqLimitLine = freqLines.find(l =>
        /^(Once|Twice|Three\s+times|\d+\s*times?)\b/i.test(l) ||
        /per\s+(calendar|benefit|plan)/i.test(l)
    ) || '';

    // ── Coinsurance ───────────────────────────────────────────────────
    const coinsPctLine = coinsLines.find(l => /\d+\s*%/.test(l)) || '';
    const coinsM       = coinsPctLine.match(/(\d+)\s*%/);

    // ── History date ──────────────────────────────────────────────────
    const noHistory    = histLines.some(l => /No history on file/i.test(l));
    const histDateLine = histLines.find(l =>
        /\d{4}-\d{2}-\d{2}/.test(l) || /\d{2}\/\d{2}\/\d{4}/.test(l)
    ) || '';
    const histDateM    = histDateLine.match(/(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);

    // ── Quadrant & alternate benefit ──────────────────────────────────
    const quadrantLine = lines.find(l => /Quadrant\s*[-–]/i.test(l)) || '';
    const quadrantM    = quadrantLine.match(/Quadrant\s*[-–]\s*([A-Z]{2})/i);
    const altBenefit   = /Alternate benefit may apply/i.test(fullText);

    return {
        procedure_code:         code,
        description:            description,
        covered:                !notCovered,
        benefit_status:         notCovered ? 'Not a covered service' : 'Covered',
        maximum_remaining:      indRemaining,
        maximum_total:          maxTotal,
        frequency_used:         freqUsedM ? `${freqUsedM[1]} of ${freqUsedM[2]}` : 'N/A',
        frequency_limit:        clean(freqLimitLine) || 'N/A',
        coinsurance_member_pct: coinsM    ? `${coinsM[1]}%`             : 'N/A',
        history_date:           noHistory ? 'No history on file'        : (histDateM?.[1] || 'N/A'),
        quadrant:               quadrantM ? quadrantM[1]                : 'N/A',
        alternate_benefit:      altBenefit,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// EXPAND + SCRAPE ALL ROWS — sequential, one row at a time
// ══════════════════════════════════════════════════════════════════════════

async function expandAndScrapeAllRows() {

    setStatus('Waiting for result rows to render…');

    let rows = [];

    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {

        rows = findResultRows();

        if (rows.length > 0) break;

        console.log('Cigna: No rows yet, waiting…');

        await sleep(1000);
    }

    if (!rows.length) {

        console.warn('Cigna: No result rows found after Submit');

        return [];
    }

    console.log(`Cigna: Processing ${rows.length} rows`);

    const results = [];

    for (let i = 0; i < rows.length; i++) {

        const row = rows[i];

        const codePeek =
            (row.innerText || '').match(/\bD\d{4}\b/)?.[0] ||
            `row${i + 1}`;

        setStatus(
            `Expanding ${codePeek} (${i + 1}/${rows.length})`
        );

        let expanded = false;

        // ─────────────────────────────────────────────
        // STRATEGY 1 — Angular Material
        // ─────────────────────────────────────────────

        const matHeader =
            row.querySelector('mat-expansion-panel-header') ||
            row.closest('mat-expansion-panel')
                ?.querySelector('mat-expansion-panel-header');

        if (matHeader) {

            const isOpen =
                matHeader.getAttribute('aria-expanded') === 'true';

            if (!isOpen) {

                console.log(
                    `Cigna: Clicking mat header for ${codePeek}`
                );

                matHeader.click();

                expanded = true;
            }
        }

        // ─────────────────────────────────────────────
        // STRATEGY 2 — aria-expanded
        // ─────────────────────────────────────────────

        if (!expanded) {

            const expanders = Array.from(
                row.querySelectorAll('[aria-expanded]')
            );

            if (expanders.length) {

                expanders.sort((a, b) => {

                    const ar =
                        b.getBoundingClientRect().right -
                        a.getBoundingClientRect().right;

                    if (Math.abs(ar) > 20) return ar;

                    return (
                        a.getBoundingClientRect().top -
                        b.getBoundingClientRect().top
                    );
                });

                const target = expanders[0];

                const isOpen =
                    target.getAttribute('aria-expanded') === 'true';

                if (!isOpen) {

                    console.log(
                        `Cigna: Clicking aria-expanded node`
                    );

                    target.click();

                    expanded = true;
                }
            }
        }

        // ─────────────────────────────────────────────
        // STRATEGY 3 — rightmost button/icon
        // ─────────────────────────────────────────────

        if (!expanded) {

            const clickables = Array.from(
                row.querySelectorAll(
                    'button, mat-icon, svg, [role="button"]'
                )
            ).filter(el => el.offsetParent !== null);

            clickables.sort((a, b) =>
                b.getBoundingClientRect().right -
                a.getBoundingClientRect().right
            );

            const target = clickables[0];

            if (target) {

                console.log(
                    `Cigna: Fallback chevron click`
                );

                target.click();

                expanded = true;
            }
        }

        // ─────────────────────────────────────────────
        // wait for expansion content
        // ─────────────────────────────────────────────

        await sleep(2000);

        await waitFor(() => {

            const txt = row.innerText || '';

            return (
                txt.includes('Maximum') ||
                txt.includes('Frequency') ||
                txt.includes('Coinsurance') ||
                txt.includes('History')
            );

        }, 7000);

        // ─────────────────────────────────────────────
        // scrape
        // ─────────────────────────────────────────────

        const data = scrapeOneRow(row);

        if (data) {

            results.push(data);

            console.log(
                `Cigna: ✓ scraped ${data.procedure_code}`,
                data
            );

        } else {

            console.warn(
                `Cigna: ✗ failed ${codePeek}`
            );
        }

        await sleep(300);
    }

    console.log(
        `Cigna: Done — ${results.length} rows`
    );

    return results;
}

// ══════════════════════════════════════════════════════════════════════════
// PROCEDURE CODE CRAWL
// ══════════════════════════════════════════════════════════════════════════

async function crawlProcedureCodesLegacy(baseData) {
    const ageLimits      = readAgeLimitsFromPage();
    const patientDOB     = baseData.patient.dob !== 'N/A' ? baseData.patient.dob : null;
    const allowedAgeCodes = filterCodesByAge(ageLimits, patientDOB);
    const excludedCodes  = AGE_GATED_LIST.filter(c => !allowedAgeCodes.includes(c));

    baseData.procedures.age_gate = {
        patient_dob:       patientDOB || 'not found',
        portal_age_limits: ageLimits,
        allowed_age_codes: allowedAgeCodes,
        excluded_codes:    excludedCodes,
    };

    const allCodes = [...STATIC_CODES, ...allowedAgeCodes, ...SPECIAL_CODES];
    const batches  = [];
    for (let i = 0; i < allCodes.length; i += 10) batches.push(allCodes.slice(i, i + 10));
    console.log(`Cigna: ${allCodes.length} codes → ${batches.length} batch(es):`, batches);

    await ensureAccordionOpen("Procedure Code Search");
    await sleep(800);

    const allResults = [];

    for (let b = 0; b < batches.length; b++) {
        setStatus(`Batch ${b + 1}/${batches.length} — clearing old codes…`);
        await clearExistingCodes();
        await sleep(800);

        const ok = await enterBatch(batches[b]);
        if (!ok) continue;

        setStatus(`Batch ${b + 1} submitted — locating result rows…`);
        const batchResults = await expandAndScrapeAllRows();

        batchResults.forEach(r => {
            if (!allResults.find(x => x.procedure_code === r.procedure_code)) allResults.push(r);
        });
    }

    baseData.procedures.codes_searched = allResults.map(r => r.procedure_code);
    baseData.procedures.count          = allResults.length;
    baseData.procedures.results        = allResults;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ══════════════════════════════════════════════════════════════════════════

function cignaMessage(action, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ command: "CIGNA_API", action, payload }, response => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response?.ok) return reject(Object.assign(new Error(response?.error || "Cigna API request failed."), {
                status: response?.status || 0, retryAfterMs: response?.retryAfterMs || 0, retryable: Boolean(response?.retryable)
            }));
            resolve(response.data);
        });
    });
}
function setStatusThrottled(msg, force = false) {
    const now = Date.now();
    if (!force && now - _lastStatusAt < 200) return;
    _lastStatusAt = now;
    setStatus(msg);
}

async function runPool(items, limit, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await worker(items[next++]);
    }));
}

function tierNumber(record) {
    for (const value of [record?.tierIndex, record?.networkTier, record?.tier]) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return Number.POSITIVE_INFINITY;
}

function preferredRecord(records, individual = false) {
    const valid = (Array.isArray(records) ? records : []).filter(Boolean);
    return valid.sort((a, b) => {
        const aTier = tierNumber(a), bTier = tierNumber(b);
        if ((aTier === 1) !== (bTier === 1)) return aTier === 1 ? -1 : 1;
        if (individual && (a.covers === "IND") !== (b.covers === "IND")) return a.covers === "IND" ? -1 : 1;
        return aTier - bTier;
    })[0];
}

function normalizeProcedureCode(value) {
    return String(value || "").trim().toUpperCase();
}

function latestHistoryDate(history) {
    if (Array.isArray(history) && history.length === 0) return "No history on file";
    const keys = ["serviceDate", "dateOfService", "dos", "date", "serviceFromDate", "fromDate"];
    const dates = (Array.isArray(history) ? history : []).flatMap(item =>
        typeof item === "string" ? [item] : keys.map(key => item?.[key]))
        .filter(value => value && !Number.isNaN(Date.parse(value)))
        .sort((a, b) => Date.parse(b) - Date.parse(a));
    return dates[0] || "N/A";
}

function apiValue(value, fallback = "N/A") {
    return value === undefined || value === null || value === "" ? fallback : value;
}

function apiBoolean(value) {
    return value === true || value === "Y" || value === "true";
}

function selectedNetwork(...records) {
    const record = records.find(Boolean);
    return {
        id: apiValue(record?.networkId),
        name: apiValue(record?.networkName),
        tier: apiValue(record?.networkTier || record?.tier || record?.tierIndex),
        type: apiValue(record?.networkType)
    };
}

function parseApiProcedure(item, requested) {
    const benefits = item.benefits || {};
    const maximum = preferredRecord(benefits.maximum?.accumulations, true);
    const coinsurance = preferredRecord(benefits.coinsurance?.accumulations);
    const deductible = preferredRecord(benefits.deductible?.accumulations, true);
    const limitation = preferredRecord(item.limitations);
    const limit = Number(limitation?.limit);
    const meaningfulFrequency = Number.isFinite(limit) && limit > 0 && limitation?.limitConsumed !== undefined && limitation?.limitConsumed !== null;
    const covered = apiBoolean(item.covered);
    const serviceHistory = normalizedHistoryEntries(item);
    return {
        procedure_code: requested.code,
        description: item.desc || requested.desc || "N/A",
        covered,
        benefit_status: covered ? "Covered" : "Not a covered service",
        maximum_remaining: apiValue(maximum?.remaining),
        maximum_total: apiValue(maximum?.amount),
        frequency_used: meaningfulFrequency ? `${limitation.limitConsumed} of ${limitation.limit}` : "N/A",
        frequency_limit: apiValue(limitation?.summary),
        coinsurance_member_pct: apiValue(coinsurance?.amount),
        history_date: latestHistoryDate(item.serviceHistory),
        quadrant: item.quadrant || "N/A",
        alternate_benefit: apiBoolean(item.alternateBenefit),
        api_details: {
            tooth: apiValue(item.tooth),
            arch: apiValue(item.arch),
            class_code: apiValue(item.classCode),
            class_description: apiValue(item.classDesc),
            procedure_group: uniqueStrings(item.procedureGroup),
            procedure_group_description: apiValue(item.procedureGroupDesc),
            notes: uniqueStrings(item.notes),
            waiting_period: uniqueStrings(item.waitingPeriod),
            validation_message: item.validationMsg || "N/A",
            context_required: getContextRequirements(item.validationMsg).length > 0,
            context_requirement: (() => {
                const fields = getContextRequirements(item.validationMsg);
                return fields.length > 1 ? fields : fields[0] || "N/A";
            })(),
            selected_network: selectedNetwork(limitation, coinsurance, maximum, deductible),
            maximum: {
                description: apiValue(maximum?.desc), total: apiValue(maximum?.amount),
                used: apiValue(maximum?.met), remaining: apiValue(maximum?.remaining),
                covers: apiValue(maximum?.covers), period: apiValue(maximum?.planPeriodCode),
                notes: uniqueStrings(maximum?.notes)
            },
            maximum_records: dedupeAccumulationRecords(benefits.maximum?.accumulations),
            deductible: {
                description: apiValue(deductible?.desc), total: apiValue(deductible?.amount),
                used: apiValue(deductible?.met), remaining: apiValue(deductible?.remaining),
                covers: apiValue(deductible?.covers), notes: uniqueStrings(deductible?.notes)
            },
            deductible_records: dedupeAccumulationRecords(benefits.deductible?.accumulations),
            coinsurance: {
                description: apiValue(coinsurance?.desc), member_percent: apiValue(coinsurance?.amount),
                notes: uniqueStrings(coinsurance?.notes)
            },
            coinsurance_records: dedupeAccumulationRecords(benefits.coinsurance?.accumulations),
            limitation: {
                limit: apiValue(limitation?.limit), consumed: apiValue(limitation?.limitConsumed),
                frequency: apiValue(limitation?.frequency), frequency_unit: apiValue(limitation?.frequencyUnit),
                minimum_age: apiValue(limitation?.minAge), maximum_age: apiValue(limitation?.maxAge),
                summary: apiValue(limitation?.summary), age_summary: apiValue(limitation?.ageSummary),
                covered: apiBoolean(limitation?.covered),
                missing_tooth_limit: limitation?.missingtoothlimit || null
            },
            limitation_records: dedupeLimitationRecords(item.limitations),
            history_dates: uniqueStrings(serviceHistory.map(entry => entry.date))
                .sort((a, b) => Date.parse(b) - Date.parse(a)),
            service_history: serviceHistory
        }
    };
}

function failedProcedure(requested, errorMessage = "Benefit response was unavailable.") {
    return {
        procedure_code: requested.code, description: requested.desc || "N/A", covered: false,
        benefit_status: "Benefit lookup failed", maximum_remaining: "N/A", maximum_total: "N/A",
        frequency_used: "N/A", frequency_limit: "N/A", coinsurance_member_pct: "N/A",
        history_date: "N/A", quadrant: "N/A", alternate_benefit: false,
        api_details: { tooth: "N/A", arch: "N/A", validation_message: "N/A", lookup_error: String(errorMessage || "Benefit lookup failed.").slice(0, 300) }
    };
}

const DESCRIPTION_CONCURRENCY = 8;
const BENEFIT_REQUEST_CONCURRENCY = 3;
const PROCEDURES_PER_REQUEST = 10;

// Cigna returns the most reliable implant details when these related D6xxx
// procedures are evaluated together. Keep them in one dedicated request and
// never mix or split this required group during normal lookup/retry handling.
const CIGNA_GROUPED_BENEFIT_BATCH_CODES = Object.freeze([
    "D6194", "D6010", "D6065", "D6056"
]);

// These are local crawler settings.  Do not try to read a same-named global in
// their initializer: `const value = typeof value ...` throws before the crawl
// starts because the local binding is still in its temporal dead zone.
const CONTEXT_REQUEST_CONCURRENCY = 4;
const INCLUDE_RAW_CONTEXT_RESULTS = false;

// Ensure commonly referenced collections exist so the crawler doesn't ReferenceError
if (typeof STATIC_CODES === 'undefined') var STATIC_CODES = [];
if (typeof SPECIAL_CODES === 'undefined') var SPECIAL_CODES = [];
if (typeof AGE_GATED_LIST === 'undefined') var AGE_GATED_LIST = [];
if (typeof QUADRANT_CODES === 'undefined') var QUADRANT_CODES = {};
if (typeof TOOTH_CODES === 'undefined') var TOOTH_CODES = {};

// Lightweight angularType fallback when running outside Angular test environment
if (typeof angularType === 'undefined') {
    async function angularType(input, value) {
        try {
            input.focus();
            input.value = value;
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(50);
        } catch (e) { /* noop */ }
    }
}

console.info('Cigna: Initialized defaults for missing globals', {
    CONTEXT_REQUEST_CONCURRENCY,
    INCLUDE_RAW_CONTEXT_RESULTS,
    STATIC_CODES: STATIC_CODES.length,
    SPECIAL_CODES: SPECIAL_CODES.length,
    AGE_GATED_LIST: AGE_GATED_LIST.length,
    QUADRANT_CODES: Object.keys(QUADRANT_CODES).length,
    TOOTH_CODES: Object.keys(TOOTH_CODES).length
});

function normalizeContextValue(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized === "N/A" ? "" : normalized;
}

function getContextRequirements(validationMessage) {
    const message = String(validationMessage || "");
    if (!/(INVALID|MISSING|REQUIRED)/i.test(message)) return [];
    return ["tooth", "arch", "quadrant"].filter(field => new RegExp(field, "i").test(message));
}

function getRequiredContextFields(validationMessage) {
    return new Set(getContextRequirements(validationMessage));
}

function contextValueIsValid(field, value) {
    return CIGNA_VALID_CONTEXT_VALUES[field]?.includes(normalizeContextValue(value));
}

function normalizeContextTask(task) {
    return {
        code: normalizeProcedureCode(task?.code),
        desc: String(task?.desc || ""),
        tooth: normalizeContextValue(task?.tooth),
        arch: normalizeContextValue(task?.arch),
        quadrant: normalizeContextValue(task?.quadrant)
    };
}

function contextKey(task) {
    const normalized = normalizeContextTask(task);
    return [normalized.code, normalized.tooth, normalized.arch, normalized.quadrant].join("|");
}

function applyDefaultContext(task, requiredFields = []) {
    const code = normalizeProcedureCode(task?.code);
    const configured = CIGNA_CONTEXT_BY_CODE[code] || {};
    const fields = new Set([...Object.keys(configured), ...requiredFields]);
    const next = normalizeContextTask(task);
    const applied = [];
    for (const field of fields) {
        if (!["tooth", "arch", "quadrant"].includes(field)) continue;
        const value = configured[field] || CIGNA_DEFAULT_CONTEXT[field];
        if (!contextValueIsValid(field, value)) continue;
        if (!next[field]) {
            next[field] = value;
            applied.push(`${field}:${value}`);
        }
    }
    return applied.length ? { ...next, _context_defaults_applied: applied } : next;
}

function contextDebugEntry(task) {
    const normalized = normalizeContextTask(task);
    const fields = ["tooth", "arch", "quadrant"].filter(field => normalized[field]);
    return {
        code: normalized.code,
        fields,
        tooth: normalized.tooth || "",
        arch: normalized.arch || "",
        quadrant: normalized.quadrant || ""
    };
}

function procedureDebugEntry(task) {
    const context = contextDebugEntry(task);
    return {
        code: context.code,
        description: String(task?.desc || ""),
        tooth: context.tooth,
        arch: context.arch,
        quadrant: context.quadrant
    };
}

function logProcedureLookupError(stage, procedures, error, attempt = 0) {
    console.error(`Cigna: ${stage} failed`, {
        procedures: (Array.isArray(procedures) ? procedures : [procedures]).map(procedureDebugEntry),
        attempt: attempt + 1,
        status: error?.status || 0,
        message: String(error?.message || error || "Unknown error")
    });
}

function expandContextTask(task, requiredFields) {
    const normalized = normalizeContextTask(task);
    const variants = CIGNA_CONTEXT_VARIANTS_BY_CODE[normalized.code];
    if (variants?.length) {
        return variants.map(variant => applyDefaultContext(
            { ...normalized, ...variant },
            [...requiredFields, ...Object.keys(variant).filter(key => ["tooth", "arch", "quadrant"].includes(key))]
        ));
    }
    if (CIGNA_ALL_QUADRANT_CONTEXT_CODES.has(normalized.code)) {
        return CIGNA_VALID_CONTEXT_VALUES.quadrant.map(quadrant =>
            applyDefaultContext({ ...normalized, quadrant }, [...requiredFields, "quadrant"]));
    }
    return [applyDefaultContext(task, [...requiredFields])];
}

async function fetchContextBatch(batch) {
    const data = await cignaMessage("benefits", { procedures: batch });
    const benefits = Array.isArray(data?.dentalBenefits) ? data.dentalBenefits : [];
    const metadata = Array.isArray(data?.containerMetadata) ? data.containerMetadata : [];
    return benefits.map((item, index) => ({
        item,
        index,
        tag: parseContainerTagKey(metadata[index]?.tagKey)
    }));
}

function matchBatchResponses(batch, responseItems, stats) {
    const byKey = new Map(batch.map(task => [contextKey(task), normalizeContextTask(task)]));
    const byCode = new Map();
    for (const task of batch) {
        const normalized = normalizeContextTask(task);
        if (!byCode.has(normalized.code)) byCode.set(normalized.code, []);
        byCode.get(normalized.code).push(normalized);
    }
    const matchedKeys = new Set();
    const matches = [];
    for (const response of Array.isArray(responseItems) ? responseItems : []) {
        const item = response.item || response;
        const returnedCode = normalizeProcedureCode(item?.procedure);
        const tag = response.tag || {};
        let task = null;
        const tagKey = contextKey(tag);
        if (tag.code && byKey.has(tagKey)) task = byKey.get(tagKey);
        if (!task && returnedCode && (byCode.get(returnedCode) || []).length === 1) {
            task = byCode.get(returnedCode)[0];
        }
        if (!task && batch[response.index]) {
            const fallback = normalizeContextTask(batch[response.index]);
            if (!returnedCode || returnedCode === fallback.code) {
                stats.positional_fallback_matches++;
                task = fallback;
            }
        }
        if (!task || (returnedCode && returnedCode !== task.code)) continue;
        const key = contextKey(task);
        if (matchedKeys.has(key)) continue;
        matchedKeys.add(key);
        matches.push({ task, item });
    }
    return {
        matches,
        missing: batch.map(normalizeContextTask).filter(task => !matchedKeys.has(contextKey(task)))
    };
}

function uniqueStrings(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).filter(value => {
        const normalized = String(value ?? "").trim();
        const key = normalized.toUpperCase();
        if (!normalized || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeComparableScalar(value) {
    return value === null || value === undefined ? "" : String(value).trim().toUpperCase();
}

function normalizeComparableStringArray(values) {
    return uniqueStrings(values).map(normalizeComparableScalar).sort();
}

function accumulationIdentityFields(record) {
    return ["desc", "amount", "met", "remaining", "covers", "networkType", "networkId",
        "tierIndex", "networkTier", "tier", "planPeriodCode", "productType", "classCode", "classDesc"]
        .map(field => normalizeComparableScalar(record?.[field]));
}

function buildAccumulationRecordKey(record) {
    return [...accumulationIdentityFields(record), normalizeComparableStringArray(record?.coveredServices).join("\u001e")].join("\u001f");
}

function dedupeRecords(records, keyBuilder, normalizeRecord = record => ({ ...record })) {
    const retained = new Map();
    for (const raw of Array.isArray(records) ? records : []) {
        if (!raw) continue;
        const record = normalizeRecord(raw);
        const key = keyBuilder(record);
        const existing = retained.get(key);
        if (existing) existing.notes = uniqueStrings([...(existing.notes || []), ...(record.notes || [])]);
        else retained.set(key, record);
    }
    return [...retained.values()];
}

function normalizeAccumulationRecord(record) {
    return { ...record, notes: uniqueStrings(record.notes), coveredServices: uniqueStrings(record.coveredServices) };
}

function dedupeAccumulationRecords(records) {
    return dedupeRecords(records, buildAccumulationRecordKey, normalizeAccumulationRecord);
}

function buildCoinsuranceRecordKey(record) {
    const details = record?.details || record;
    return [normalizeComparableScalar(record?.class_code ?? details?.classCode),
        normalizeComparableScalar(record?.category ?? details?.classDesc),
        normalizeComparableScalar(record?.patient_pays ?? details?.amount),
        ...accumulationIdentityFields(details), normalizeComparableStringArray(details?.coveredServices).join("\u001e")].join("\u001f");
}

function dedupeCoinsuranceRecords(records) {
    return dedupeRecords(records, buildCoinsuranceRecordKey, record => ({
        ...record,
        ...(record.details ? { details: normalizeAccumulationRecord(record.details) } : normalizeAccumulationRecord(record))
    }));
}

function buildLimitationRecordKey(record) {
    return ["procedureCode", "networkType", "networkId", "tierIndex", "networkTier", "tier", "summary",
        "limit", "limitConsumed", "frequency", "frequencyUnit", "ageSummary", "minAge", "maxAge",
        "waitingPeriod", "productType", "covers"].map(field => normalizeComparableScalar(record?.[field])).join("\u001f");
}

function dedupeLimitationRecords(records) {
    return dedupeRecords(records, buildLimitationRecordKey, record => ({ ...record, notes: uniqueStrings(record.notes) }));
}

function historyRecordKey(entry) {
    const claim = entry?.claimId ?? entry?.claimNumber ?? entry?.providerId ?? entry?.providerName ?? "";
    return [entry?.date, entry?.procedureCode ?? entry?.procedure, entry?.tooth, entry?.surface,
        entry?.quadrant, entry?.arch, claim].map(normalizeComparableScalar).join("\u001f");
}

function mergeDuplicateResponse(target, source, stats) {
    const history = [...(target.serviceHistory || []), ...(source.serviceHistory || [])];
    const seenHistory = new Set();
    target.serviceHistory = history.filter(entry => {
        const raw = typeof entry === "string" ? { date: entry } : entry;
        const key = historyRecordKey(raw);
        if (seenHistory.has(key)) return false;
        seenHistory.add(key); return true;
    });
    for (const field of ["notes", "waitingPeriod", "procedureGroup"]) target[field] = uniqueStrings([...(target[field] || []), ...(source[field] || [])]);
    stats.duplicate_responses_merged++;
    return target;
}

function parseContainerTagKey(tagKey) {
    const identity = String(tagKey || "").split("#").pop();
    const [code = "", tooth = "", arch = "", quadrant = ""] = identity.split("~");
    return { code: normalizeProcedureCode(code), tooth: normalizeContextValue(tooth), arch: normalizeContextValue(arch), quadrant: normalizeContextValue(quadrant) };
}

async function resolveContextQueue(requested, initialByCode, run, stats, progress) {
    const queues = new Map();
    const resultByKey = new Map();
    const requiredByCode = new Map();
    let order = 0;
    let activeRequestCount = 0;
    const schedule = task => {
        const normalized = normalizeContextTask(task), key = contextKey(normalized);
        if (run.scheduledKeys.has(key) || run.activeKeys.has(key) || run.completedKeys.has(key)) {
            stats.duplicate_requests_skipped++;
            return;
        }
        run.scheduledKeys.add(key);
        if (!queues.has(normalized.code)) queues.set(normalized.code, []);
        queues.get(normalized.code).push({ ...normalized, order: order++ });
    };
    for (const request of requested) {
        const initial = initialByCode.get(request.code);
        const fields = getRequiredContextFields(initial?.validationMsg);
        requiredByCode.set(request.code, new Set(fields));
        if (fields.size || CIGNA_ALL_QUADRANT_CONTEXT_CODES.has(request.code) || CIGNA_FORCED_CONTEXT_CODES.has(request.code)) {
            expandContextTask({ ...request, depth: 0 }, fields).forEach(schedule);
        }
        else if (initial) resultByKey.set(contextKey(request), { task: normalizeContextTask(request), item: initial, classification: apiBoolean(initial.covered) ? "resolved_covered" : "resolved_not_covered", order: order++ });
    }
    while ([...queues.values()].some(queue => queue.length)) {
        if (run.cancelled || activeCignaRun !== run) throw new Error("Cigna crawl superseded by a newer run.");
        const batches = [];
        while ([...queues.values()].some(queue => queue.length)) {
            const batch = [];
            for (const code of PROCEDURE_CODES) {
                const queue = queues.get(code);
                if (queue?.length && batch.length < PROCEDURES_PER_REQUEST) batch.push(queue.shift());
            }
            if (!batch.length) break;
            batches.push(batch);
        }
        await runPool(batches, CONTEXT_REQUEST_CONCURRENCY, async batch => {
            batch.forEach(task => { run.activeKeys.add(contextKey(task)); });
            activeRequestCount++;
            stats.maximum_concurrency_observed = Math.max(stats.maximum_concurrency_observed, activeRequestCount);
            let items = [];
            try {
                stats.context_benefit_requests++;
                items = await fetchContextBatch(batch);
            } catch (error) {
                logProcedureLookupError("Context-specific procedure benefit lookup", batch, error);
                throw error;
            } finally {
                activeRequestCount--;
                batch.forEach(task => run.activeKeys.delete(contextKey(task)));
            }
            const matched = matchBatchResponses(batch, items, stats);
            for (const task of [...matched.missing]) {
                stats.missing_response_retries++;
                let retryItems;
                try {
                    retryItems = await fetchContextBatch([task]);
                } catch (error) {
                    logProcedureLookupError("Context-specific procedure retry", task, error);
                    throw error;
                }
                const retryMatch = matchBatchResponses([task], retryItems, stats);
                if (retryMatch.matches.length) {
                    matched.matches.push(...retryMatch.matches);
                    matched.missing.splice(matched.missing.indexOf(task), 1);
                }
            }
            const { matches, missing } = matched;
            for (const { task, item } of matches) {
                const key = contextKey(task);
                run.completedKeys.add(key);
                const fields = getRequiredContextFields(item.validationMsg);
                const required = requiredByCode.get(task.code) || new Set();
                fields.forEach(field => required.add(field));
                requiredByCode.set(task.code, required);
                const candidates = expandContextTask(task, fields);
                const classification = fields.size && candidates.length ? "context_validation" : fields.size ? "api_failure" : apiBoolean(item.covered) ? "resolved_covered" : "resolved_not_covered";
                resultByKey.set(key, { task, item, classification, order: task.order });
                candidates.forEach(schedule);
            }
            for (const task of missing) {
                run.completedKeys.add(contextKey(task));
                resultByKey.set(contextKey(task), { task, item: null, classification: "api_failure", order: task.order });
            }
            progress(resultByKey.size, [...queues.values()].reduce((sum, queue) => sum + queue.length, 0), run.activeKeys.size);
        });
    }
    return { resultByKey, requiredByCode };
}

function normalizedHistoryEntries(record) {
    const item = record?.item || record || {};
    const task = record?.task || item;
    const history = item.serviceHistory;
    if (!Array.isArray(history)) return [];
    const seen = new Set();
    return history.flatMap(entry => {
        const raw = typeof entry === "string" ? entry : ["serviceDate", "dateOfService", "dos", "date", "serviceFromDate", "fromDate"].map(key => entry?.[key]).find(Boolean);
        if (!raw || Number.isNaN(Date.parse(raw))) return [];
        const normalized = {
            ...(entry && typeof entry === "object" ? entry : {}),
            date: raw,
            tooth: entry?.tooth || task.tooth || "N/A",
            arch: entry?.arch || task.arch || "N/A",
            quadrant: entry?.quadrant || task.quadrant || "N/A"
        };
        const key = historyRecordKey(normalized);
        if (seen.has(key)) return [];
        seen.add(key);
        return [normalized];
    });
}

function buildAggregatedProcedure(request, initial, records, requiredFields, stats) {
    const resolved = records.filter(record => record.classification === "resolved_covered" || record.classification === "resolved_not_covered").sort((a, b) => a.order - b.order);
    const histories = [], historyKeys = new Set();
    const historySources = initial ? [{ task: normalizeContextTask(request), item: initial }, ...resolved] : resolved;
    for (const record of historySources) for (const history of normalizedHistoryEntries(record)) {
        const key = [history.date, history.tooth, history.arch, history.quadrant].join("|");
        if (historyKeys.has(key)) { stats.histories_deduplicated++; continue; }
        historyKeys.add(key); histories.push(history);
    }
    const representative = resolved.find(record => normalizedHistoryEntries(record).length) || resolved.find(record => record.classification === "resolved_covered") || resolved[0];
    if (!representative) {
        const failed = failedProcedure(request);
        Object.assign(failed.api_details, {
            coverage_scope: "unresolved", covered_any: false, covered_all: false,
            resolved_context_count: 0, covered_context_count: 0, not_covered_context_count: 0,
            unresolved_context_count: records.length || 1, required_context_fields: [...requiredFields],
            representative_context: { tooth: "N/A", arch: "N/A", quadrant: "N/A", selection_reason: "N/A" },
            varies_by_context: false, service_history: [], context_groups: []
        });
        failed.benefit_status = "Context validation unresolved";
        return failed;
    }
    const parsed = parseApiProcedure(representative.item, representative.task);
    const coveredCount = resolved.filter(record => record.classification === "resolved_covered").length;
    const notCoveredCount = resolved.length - coveredCount;
    const initialFields = getRequiredContextFields(initial?.validationMsg);
    const forcedContext = CIGNA_ALL_QUADRANT_CONTEXT_CODES.has(request.code) || CIGNA_FORCED_CONTEXT_CODES.has(request.code);
    const scope = !initialFields.size && !forcedContext ? "context_independent" : coveredCount && notCoveredCount ? "partial" : coveredCount ? "all" : resolved.length ? "none" : "unresolved";
    const uniqueContext = field => [...new Set(resolved.map(record => record.task[field]).filter(Boolean))];
    const outcomeGroups = new Map();
    for (const record of resolved) {
        const detail = parseApiProcedure(record.item, record.task);
        const outcome = {
            covered: detail.covered, validation_message: detail.api_details.validation_message,
            selected_network: detail.api_details.selected_network, maximum: detail.api_details.maximum,
            deductible: detail.api_details.deductible, coinsurance: detail.api_details.coinsurance,
            limitation: detail.api_details.limitation, alternate_benefit: detail.alternate_benefit,
            histories: normalizedHistoryEntries(record), notes: detail.api_details.notes,
            waiting_period: detail.api_details.waiting_period,
            procedure_group: detail.api_details.procedure_group
        };
        const signature = JSON.stringify(outcome);
        if (!outcomeGroups.has(signature)) outcomeGroups.set(signature, { outcome, contexts: [] });
        outcomeGroups.get(signature).contexts.push({ tooth: record.task.tooth || "N/A", arch: record.task.arch || "N/A", quadrant: record.task.quadrant || "N/A" });
    }
    parsed.covered = coveredCount > 0;
    parsed.benefit_status = scope === "partial" ? "Partially covered by context" : scope === "unresolved" ? "Context validation unresolved" : parsed.covered ? "Covered" : "Not a covered service";
    parsed.history_date = histories.length ? histories.map(item => item.date).sort((a, b) => Date.parse(b) - Date.parse(a))[0] : resolved.every(record => Array.isArray(record.item?.serviceHistory) && !record.item.serviceHistory.length) ? "No history on file" : "N/A";
    parsed.quadrant = uniqueContext("quadrant").length === 1 ? uniqueContext("quadrant")[0] : "N/A";
    Object.assign(parsed.api_details, {
        coverage_scope: scope, covered_any: coveredCount > 0, covered_all: resolved.length > 0 && coveredCount === resolved.length,
        resolved_context_count: resolved.length, covered_context_count: coveredCount, not_covered_context_count: notCoveredCount,
        unresolved_context_count: records.filter(record => record.classification === "api_failure").length, required_context_fields: [...requiredFields],
        representative_context: { tooth: representative.task.tooth || "N/A", arch: representative.task.arch || "N/A", quadrant: representative.task.quadrant || "N/A", selection_reason: normalizedHistoryEntries(representative).length ? "resolved_context_with_history" : representative.classification === "resolved_covered" ? "first_covered_context_by_candidate_order" : "first_resolved_context_by_candidate_order" },
        tooth: uniqueContext("tooth").length === 1 ? uniqueContext("tooth")[0] : "N/A",
        arch: uniqueContext("arch").length === 1 ? uniqueContext("arch")[0] : "N/A",
        varies_by_context: outcomeGroups.size > 1, service_history: histories,
        context_groups: [...outcomeGroups.values()], initial_validation: initial?.validationMsg || "N/A"
    });
    delete parsed.api_details.context_results;
    if (INCLUDE_RAW_CONTEXT_RESULTS) parsed.api_details.context_results = records;
    if (!parsed.covered && (parsed.maximum_total !== "N/A" || parsed.coinsurance_member_pct !== "N/A")) parsed.api_details.raw_benefit_values_present_for_noncovered_service = true;
    return parsed;
}

function displayApiDate(value, presentFor9999 = false) {
    if (!value) return "N/A";
    if (presentFor9999 && String(value).startsWith("9999-")) return "Present";
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function titleCaseApi(value) {
    return value ? String(value).toLowerCase().replace(/\b\w/g, character => character.toUpperCase()) : "N/A";
}

function coverageServiceRecords(coverage, benefitName) {
    return (coverage.planBenefits?.services || []).flatMap(service =>
        (service.benefits?.[benefitName]?.accumulations || []).map(record => ({ ...record, classCode: service.classCode, classDesc: service.classCodeDesc })));
}

function formatApiAddress(address) {
    if (!address || typeof address !== "object") return "N/A";
    const street = uniqueStrings(address.lines || []).join(", ");
    const locality = [address.city, address.state].filter(Boolean).join(", ");
    return [street, [locality, address.zip].filter(Boolean).join(" "), address.country].filter(Boolean).join("\n") || "N/A";
}

function completeAccumulationRecords(coverage, benefitName) {
    return dedupeAccumulationRecords(coverageServiceRecords(coverage, benefitName));
}

function selectedCoverageNetwork(coverage) {
    const network = coverage?.coverageDetails?.networkDetails || {};
    return {
        id: apiValue(network.superNetworkId || network.networkId, ""),
        name: apiValue(network.networkName, ""),
        type: apiValue(network.networkType, ""),
        tier: apiValue(network.tier, "")
    };
}

function normalizedNetworkName(value) {
    return normalizeComparableScalar(value).replace(/\s+NETWORK$/, "").trim();
}

function matchesSelectedCoverageNetwork(record, selected) {
    const selectedId = normalizeComparableScalar(selected?.id);
    const recordId = normalizeComparableScalar(record?.networkId || record?.network_id);
    if (selectedId) return recordId === selectedId;
    const selectedName = normalizedNetworkName(selected?.name);
    const recordName = normalizedNetworkName(record?.networkName || record?.network);
    return Boolean(selectedName) && recordName === selectedName;
}

function selectedCoverageRecords(records, selected) {
    const valid = (Array.isArray(records) ? records : []).filter(Boolean);
    if (!selected?.id && !selected?.name) return valid;
    return valid.filter(record => matchesSelectedCoverageNetwork(record, selected));
}

function deductibleApplicabilityFromCoverage(coverage) {
    const selected = selectedCoverageNetwork(coverage);
    const records = selectedCoverageRecords(
        coverageServiceRecords(coverage, "deductible"),
        selected
    );
    const classCodes = uniqueStrings(records.flatMap(record =>
        String(record.classCode || "").split(",").map(value => value.trim()).filter(Boolean)));
    const classDescriptions = uniqueStrings(records.flatMap(record =>
        String(record.classDesc || "").split(",").map(value => value.trim()).filter(Boolean)));
    const descriptions = classDescriptions.join(",").toUpperCase();
    const hasCode = code => classCodes.includes(code);
    return {
        selected_network: selected,
        has_selected_network_deductible: records.length > 0,
        class_codes: classCodes,
        class_descriptions: classDescriptions,
        diagnostic: hasCode("1") || descriptions.includes("DIAGNOSTIC"),
        preventive: hasCode("1") || descriptions.includes("PREVENTIVE"),
        basic: hasCode("2") || descriptions.includes("BASIC RESTORATIVE"),
        major: hasCode("3") || descriptions.includes("MAJOR RESTORATIVE"),
        orthodontic: hasCode("4") || descriptions.includes("ORTHODONT"),
        periodontal: hasCode("6") || descriptions.includes("PERIODONTAL"),
        implants: hasCode("9") || descriptions.includes("IMPLANT")
    };
}

function applyCoverageApi(baseData, coverage) {
    const patient = coverage.patientDetails || {};
    const subscriber = coverage.subscriberDetails || {};
    const details = coverage.coverageDetails || {};
    const network = details.networkDetails || {};
    const plan = details.plan || {};
    baseData.summary = {
        patient_id: apiValue(patient.id),
        group_number: apiValue(details.accountNumber),
        group_name: apiValue(details.accountName),
        plan_type: apiValue(details.plan?.type),
        coverage_dates: { from: displayApiDate(details.effectiveFrom), to: displayApiDate(details.effectiveTill, true) },
        as_of_date: displayApiDate(coverage.asofDate)
    };
    baseData.patient = {
        name: apiValue(patient.fullName), dob: displayApiDate(patient.dob),
        gender: titleCaseApi(patient.gender), relationship: titleCaseApi(patient.relationship),
        address: formatApiAddress(patient.addresses?.[0])
    };
    baseData.plan_details = {
        subscriber: apiValue(subscriber.fullName),
        subscriber_dob: displayApiDate(subscriber.dob),
        plan_type: apiValue(plan.type),
        plan_renews: titleCaseApi(plan.planYears?.renewalType?.replace(/_/g, " ")),
        initial_coverage_date: displayApiDate(details.initialCoverageDate),
        current_coverage: {
            from: displayApiDate(details.effectiveFrom),
            to: displayApiDate(details.effectiveTill, true)
        },
        other_insurance: details.otherInsurance ? "Yes" : "No",
        account_number: apiValue(details.accountNumber),
        account_name: apiValue(details.accountName),
        network: {
            id: apiValue(network.superNetworkId || network.networkId),
            name: apiValue(network.networkName),
            type: apiValue(network.networkType),
            tier: apiValue(network.tier)
        },
        electronic_claims: apiValue(
            (coverage.serviceContact || []).find(item => item?.web)?.web ||
            document.querySelector('a[href*="EDIvendors" i]')?.href
        )
    };
    baseData.financials = {
        maximum_records: completeAccumulationRecords(coverage, "maximum"),
        deductible_records: completeAccumulationRecords(coverage, "deductible"),
        deductible_applicability: deductibleApplicabilityFromCoverage(coverage)
    };
    baseData.coinsurance = dedupeCoinsuranceRecords((coverage.planBenefits?.services || []).flatMap(service => {
        const records = service.benefits?.coinsurance?.accumulations;
        if (!records?.length) return [];
        return records.map(record => ({
            network: apiValue(record?.networkName || network.networkName),
            network_id: apiValue(record?.networkId),
            category: service.classCodeDesc || service.classCode,
            class_code: apiValue(service.classCode),
            patient_pays: apiValue(record?.amount),
            details: { ...record, notes: uniqueStrings(record.notes), coveredServices: uniqueStrings(record.coveredServices) }
        }));
    }));
    baseData.frequencies = dedupeRecords((coverage.frequencyAgeLimitation?.procedural || []).map(item => {
        const limitation = preferredRecord(item.limitations);
        return {
            network: apiValue(limitation?.networkName || network.networkName),
            network_id: apiValue(limitation?.networkId),
            procedure_code: apiValue(item.procedureCode),
            procedure: apiValue(item.procedureDesc),
            age_limitation: apiValue(limitation?.ageSummary),
            limit: apiValue(limitation?.summary),
            limitation_records: dedupeLimitationRecords(item.limitations),
            waiting_period: item.waitingPeriod || item.WaitingPeriod || null
        };
    }), record => [record.procedure_code, buildLimitationRecordKey(record.limitation_records?.[0] || {}),
        normalizeComparableScalar(record.limit), normalizeComparableScalar(record.age_limitation),
        normalizeComparableScalar(record.waiting_period)].join("\u001f"));
    const ageRecords = coverage.frequencyAgeLimitation?.ageLimitations || [];
    const age = preferredRecord(ageRecords);
    const meaningfulAgeRecord = value => value && typeof value === "object" && Object.values(value).some(item => item !== null && item !== undefined && item !== "");
    baseData.age_limits = dedupeRecords(ageRecords.flatMap(record => [
        meaningfulAgeRecord(record?.student) ? { network: apiValue(record.student.networkName), network_id: apiValue(record.student.networkId), type: "Student Age Limitation **", age: apiValue(record.student.limit), ends: apiValue(record.coverageEnds?.limit), details: { ...record.student } } : null,
        meaningfulAgeRecord(record?.dependent) ? { network: apiValue(record.dependent.networkName), network_id: apiValue(record.dependent.networkId), type: "Dependent Age Limitation **", age: apiValue(record.dependent.limit), ends: apiValue(record.coverageEnds?.limit), details: { ...record.dependent } } : null,
        meaningfulAgeRecord(record?.ortho) ? { network: apiValue(record.ortho.networkName), network_id: apiValue(record.ortho.networkId), type: "Ortho Age Limitation **", age: apiValue(record.ortho.limit), ends: apiValue(record.orthoCoverageEnds?.limit), details: { ...record.ortho } } : null
    ]).filter(Boolean), record => [record.type, record.age, record.ends, buildLimitationRecordKey(record.details)].map(normalizeComparableScalar).join("\u001f"));
    baseData.notes = {
        ...baseData.notes,
        missing_tooth: age?.missingtoothLimit?.missingToothLimitIndicator === "N" ? "Does not apply" : apiValue(age?.missingtoothLimit?.missingToothLimitEndDate),
        ortho_note: "Orthodontic age limitations may differ from other age limitations on the plan; contact Customer Support for Orthodontic eligibility requirements.",
        plan_notes: uniqueStrings(coverage.planBenefits?.notes),
        waiting_period: uniqueStrings(coverage.waitingPeriod)
    };
}

function buildBenefitBatches(procedures) {
    const byCode = new Map(procedures.map(item => [normalizeProcedureCode(item?.code), item]));
    const groupedBatch = CIGNA_GROUPED_BENEFIT_BATCH_CODES.map(code => byCode.get(code)).filter(Boolean);
    if (groupedBatch.length !== CIGNA_GROUPED_BENEFIT_BATCH_CODES.length) {
        const missing = CIGNA_GROUPED_BENEFIT_BATCH_CODES.filter(code => !byCode.has(code));
        throw new Error(`Required grouped Cigna procedure batch is incomplete: ${missing.join(", ")}`);
    }

    const groupedCodes = new Set(CIGNA_GROUPED_BENEFIT_BATCH_CODES);
    const remaining = procedures.filter(item => !groupedCodes.has(normalizeProcedureCode(item?.code)));
    const batches = [groupedBatch];
    for (let i = 0; i < remaining.length; i += PROCEDURES_PER_REQUEST) {
        batches.push(remaining.slice(i, i + PROCEDURES_PER_REQUEST));
    }
    console.info("Cigna: Dedicated grouped benefit batch", groupedBatch.map(procedureDebugEntry));
    return batches;
}

function isGroupedBenefitBatch(batch) {
    if (!Array.isArray(batch) || batch.length !== CIGNA_GROUPED_BENEFIT_BATCH_CODES.length) return false;
    const codes = new Set(batch.map(item => normalizeProcedureCode(item?.code)));
    return CIGNA_GROUPED_BENEFIT_BATCH_CODES.every(code => codes.has(code));
}

function matchBenefitResponse(batch, data, found, failures, stats) {
    const requested = new Map(batch.map(item => [item.code, item]));
    const items = Array.isArray(data?.dentalBenefits) ? data.dentalBenefits : [];
    const metadata = Array.isArray(data?.containerMetadata) ? data.containerMetadata : [];
    items.forEach((item, index) => {
        const metadataCode = parseContainerTagKey(metadata[index]?.tagKey).code;
        const returnedCode = normalizeProcedureCode(item?.procedure);
        const code = metadataCode && requested.has(metadataCode) ? metadataCode : returnedCode;
        if (!requested.has(code) || (returnedCode && returnedCode !== code)) {
            if (metadataCode && requested.has(metadataCode)) failures[metadataCode] = `Response code mismatch: expected ${metadataCode}, received ${returnedCode || "none"}.`;
            return;
        }
        if (found.has(code)) mergeDuplicateResponse(found.get(code), item, stats);
        else found.set(code, item);
    });
    return batch.filter(item => !found.has(item.code));
}

function normalizedIdentity(value) {
    return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function assertPatientConsistency(domData, coverage) {
    const apiPatient = coverage?.patientDetails || {};
    const domMember = normalizedIdentity(domData?.summary?.patient_id);
    const apiMember = normalizedIdentity(apiPatient.id);
    const domDob = normalizedIdentity(domData?.patient?.dob);
    const apiDob = normalizedIdentity(displayApiDate(apiPatient.dob));
    const domName = normalizedIdentity(domData?.patient?.name);
    const apiName = normalizedIdentity(apiPatient.fullName);
    if ((domMember && apiMember && domMember !== apiMember) ||
        (domDob && apiDob && domDob !== apiDob) ||
        (!domMember && !domDob && domName && apiName && domName !== apiName)) {
        throw new Error("The captured Cigna API session belongs to a different patient. Reload the selected patient's Dental Coverage page and run again.");
    }
}

async function fetchBenefitBatch(batch, found, failures, stats, attempt = 0) {
    try {
        stats.benefit_http_requests++;
        console.info("Cigna: Looking up procedure benefits", {
            procedures: batch.map(procedureDebugEntry), attempt: attempt + 1
        });
        const data = await cignaMessage("benefits", { procedures: batch });
        const omitted = matchBenefitResponse(batch, data, found, failures, stats);
        if (omitted.length) {
            stats.missing_response_retries++;
            if (isGroupedBenefitBatch(batch)) {
                // Re-request the complete implant group so its codes are never
                // evaluated separately after a partial/omitted API response.
                if (attempt < 2) return fetchBenefitBatch(batch, found, failures, stats, attempt + 1);
                throw Object.assign(new Error("Cigna response repeatedly omitted procedures from the required grouped implant batch."), {
                    status: 422,
                    preserveGroupedBatch: true
                });
            }
            if (omitted.length < batch.length) return fetchBenefitBatch(omitted, found, failures, stats);
            throw Object.assign(new Error("Cigna response omitted requested procedures."), { status: 422 });
        }
    } catch (error) {
        logProcedureLookupError("Procedure benefit lookup", batch, error, attempt);
        if (error.status === 401 || error.status === 403) throw error;
        if (error.status === 429 && attempt < 3) {
            stats.retry_http_requests++;
            await sleep((error.retryAfterMs || 1000 * (2 ** attempt)) + Math.floor(Math.random() * 250));
            return fetchBenefitBatch(batch, found, failures, stats, attempt + 1);
        }
        if ((!error.status || error.status >= 500) && attempt < 2) {
            stats.retry_http_requests++;
            await sleep(500 * (2 ** attempt) + Math.floor(Math.random() * 200));
            return fetchBenefitBatch(batch, found, failures, stats, attempt + 1);
        }
        const splittable = [400, 413, 422].includes(error.status);
        const preserveGroupedBatch = isGroupedBenefitBatch(batch) || error.preserveGroupedBatch;
        if (splittable && batch.length > 1 && !preserveGroupedBatch) {
            stats.split_http_requests += 2;
            const middle = Math.ceil(batch.length / 2);
            await fetchBenefitBatch(batch.slice(0, middle), found, failures, stats);
            await fetchBenefitBatch(batch.slice(middle), found, failures, stats);
        } else for (const item of batch) {
            if (found.has(item.code)) continue;
            failures[item.code] = String(error.message || "Benefit lookup failed.").slice(0, 300);
            console.error("Cigna: Procedure benefit lookup ultimately failed", {
                procedure: procedureDebugEntry(item),
                status: error.status || 0,
                message: failures[item.code]
            });
        }
    }
}

function validateProcedureResultIntegrity(results) {
    if (!Array.isArray(results)) throw new Error("Procedure results were not generated.");
    if (results.length !== PROCEDURE_CODES.length) throw new Error(`Expected ${PROCEDURE_CODES.length} procedure results, received ${results.length}.`);
    const codes = results.map(item => item.procedure_code);
    if (new Set(codes).size !== PROCEDURE_CODES.length) throw new Error("Duplicate procedure codes detected.");
    for (let index = 0; index < PROCEDURE_CODES.length; index++) {
        if (codes[index] !== PROCEDURE_CODES[index]) throw new Error(`Procedure order mismatch at index ${index}: expected ${PROCEDURE_CODES[index]}, received ${codes[index]}.`);
    }
}

function validateCignaNormalization(data) {
    const checks = [
        ["maximum_records", data?.financials?.maximum_records, buildAccumulationRecordKey],
        ["deductible_records", data?.financials?.deductible_records, buildAccumulationRecordKey],
        ["coinsurance", data?.coinsurance, buildCoinsuranceRecordKey],
        ["age_limits", data?.age_limits, record => [record.type, record.age, record.ends, buildLimitationRecordKey(record.details)].map(normalizeComparableScalar).join("\u001f")],
        ["frequencies", data?.frequencies, record => [record.procedure_code, buildLimitationRecordKey(record.limitation_records?.[0] || {}), record.limit, record.age_limitation, record.waiting_period].map(normalizeComparableScalar).join("\u001f")],
        ["procedures", data?.procedures?.results, record => normalizeProcedureCode(record?.procedure_code)]
    ];
    const summary = {};
    for (const [name, records, keyBuilder] of checks) {
        const list = Array.isArray(records) ? records : [];
        const unique = new Set(list.map(keyBuilder)).size;
        summary[name] = { count: list.length, unique, duplicates: list.length - unique };
    }
    console.info("Cigna normalization:", summary);
    return summary;
}

async function crawlProcedureCodes(baseData, run) {
    run.scheduledKeys = run.scheduledKeys || new Set();
    run.activeKeys = run.activeKeys || new Set();
    run.completedKeys = run.completedKeys || new Set();
    const patientDOB = baseData.patient.dob !== "N/A" ? baseData.patient.dob : null;
    baseData.procedures.age_gate = {
        patient_dob: patientDOB || "not found",
        allowed_age_codes: [], age_restricted_codes: [], excluded_codes: [],
        age_gate_mode: "api_authoritative"
    };
    await cignaMessage("session");
    const descriptions = {};
    const startedAt = Date.now();
    const stats = {
        coverage_http_requests: 1, description_http_requests: 0, benefit_http_requests: 0,
        context_benefit_requests: 0, retry_http_requests: 0, split_http_requests: 0,
        missing_response_retries: 0, duplicate_requests_skipped: 0, duplicate_responses_merged: 0,
        positional_fallback_matches: 0, context_defaults_applied: 0, context_resolution_successes: 0,
        context_resolution_unresolved: 0, histories_deduplicated: 0,
        maximum_concurrency_observed: 0, duration_ms: 0
    };
    setStatusThrottled("Resolving procedure descriptions", true);
    const cached = await new Promise(resolve => chrome.storage.local.get(PROCEDURE_CODES.map(code => `cigna_description_${code}`), resolve));
    let resolved = 0;
    await runPool(PROCEDURE_CODES, DESCRIPTION_CONCURRENCY, async code => {
        const saved = cached[`cigna_description_${code}`];
        if (saved?.code === code && saved.description) descriptions[code] = saved.description;
        else try { stats.description_http_requests++; descriptions[code] = (await cignaMessage("description", { code })).description || ""; }
        catch (error) {
            descriptions[code] = "";
            console.warn("Cigna: Procedure description lookup failed; continuing without a description", {
                procedure: { code }, status: error?.status || 0, message: String(error?.message || error)
            });
        }
        setStatusThrottled(`Resolving procedure descriptions: ${++resolved}/${PROCEDURE_CODES.length}`);
    });
    if (run.cancelled || activeCignaRun !== run) throw new Error("Cigna crawl superseded by a newer run.");
    const requested = PROCEDURE_CODES.map(code => applyDefaultContext({ code, desc: descriptions[code], tooth: "", arch: "", quadrant: "" }));
    const contextDefaultsApplied = requested
        .filter(item => item._context_defaults_applied?.length)
        .map(contextDebugEntry);
    stats.context_defaults_applied = contextDefaultsApplied.length;
    if (contextDefaultsApplied.length) console.info("Cigna default procedure contexts:", contextDefaultsApplied);
    const found = new Map(), failures = {};
    const batches = buildBenefitBatches(requested);
    let completedBatches = 0, activeRequests = 0;
    await runPool(batches, BENEFIT_REQUEST_CONCURRENCY, async batch => {
        activeRequests++; stats.maximum_concurrency_observed = Math.max(stats.maximum_concurrency_observed, activeRequests);
        setStatusThrottled(`Fetching procedure benefits: batch ${completedBatches + 1}/${batches.length}`);
        try { await fetchBenefitBatch(batch, found, failures, stats); } finally { activeRequests--; completedBatches++; }
    });
    if (run.cancelled || activeCignaRun !== run) throw new Error("Cigna crawl superseded by a newer run.");
    const contextRequests = requested.filter(req =>
        getContextRequirements(found.get(req.code)?.validationMsg).length ||
        CIGNA_ALL_QUADRANT_CONTEXT_CODES.has(req.code) ||
        CIGNA_FORCED_CONTEXT_CODES.has(req.code));
    const resolvedByCode = new Map();
    let contextResolution = {
        defaults_applied: contextDefaultsApplied,
        attempted_codes: [],
        resolved_codes: [],
        unresolved_codes: []
    };
    if (contextRequests.length) {
        contextResolution.attempted_codes = contextRequests.flatMap(req =>
            expandContextTask(req, getRequiredContextFields(found.get(req.code)?.validationMsg)).map(contextDebugEntry));
        try {
            const debugList = contextRequests.map(req => {
                const validation = found.get(req.code)?.validationMsg;
                const required = getContextRequirements(validation);
                const variants = expandContextTask(req, getRequiredContextFields(validation)).map(contextDebugEntry);
                return { code: req.code, required, variants };
            });
            console.log('Cigna: Context resolution details for codes requiring input:', debugList);
        } catch (e) { console.warn('Cigna: Failed to build context debug list', e); }
        setStatusThrottled(`Resolving required tooth/arch/quadrant context: ${contextRequests.length} code(s)`, true);
        const contextResult = await resolveContextQueue(
            contextRequests,
            found,
            run,
            stats,
            (done, queued, active) => setStatusThrottled(`Resolving Cigna context: ${done} done, ${queued} queued, ${active} active`)
        );
        for (const req of contextRequests) {
            const records = [...contextResult.resultByKey.values()]
                .filter(record => record.task?.code === req.code);
            const parsed = buildAggregatedProcedure(
                req,
                found.get(req.code),
                records,
                contextResult.requiredByCode.get(req.code) || new Set(),
                stats
            );
            resolvedByCode.set(req.code, parsed);
            if (parsed.api_details?.coverage_scope === "unresolved") contextResolution.unresolved_codes.push(req.code);
            else contextResolution.resolved_codes.push(req.code);
        }
        stats.context_resolution_successes = contextResolution.resolved_codes.length;
        stats.context_resolution_unresolved = contextResolution.unresolved_codes.length;
        console.info("Cigna context resolution:", contextResolution);
    }
    setStatusThrottled(`Finalizing ${PROCEDURE_CODES.length} procedure results`, true);
    const validationSummary = { tooth_required: [], arch_required: [], quadrant_required: [], multi_field_required: [] };
    const results = requested.map(req => {
        if (resolvedByCode.has(req.code)) return resolvedByCode.get(req.code);
        const item = found.get(req.code);
        if (!item) return failedProcedure(req, failures[req.code]);
        const returnedCode = normalizeProcedureCode(item.procedure);
        if (returnedCode && returnedCode !== req.code) return failedProcedure(req, `Response code mismatch: received ${returnedCode}.`);
        const fields = getContextRequirements(item.validationMsg);
        if (fields.length > 1) validationSummary.multi_field_required.push(req.code);
        else if (fields[0]) validationSummary[`${fields[0]}_required`].push(req.code);
        return parseApiProcedure(item, req);
    });
    validateProcedureResultIntegrity(results);
    baseData.procedures.codes_searched = [...PROCEDURE_CODES];
    baseData.procedures.results = results;
    baseData.procedures.count = results.length;
    stats.duration_ms = Date.now() - startedAt;
    baseData.procedures.api_meta = { request_stats: stats, validation_summary: validationSummary, context_resolution: contextResolution, failures };
    setStatusThrottled(`Procedure API complete: ${results.length}/${PROCEDURE_CODES.length}`, true);
}

async function runCignaCrawl(run) {
    if (!chrome.runtime?.id) return null;

    setStatus('Scraping page data…');
    const fullData = scrapeCignaFull();
    if (!fullData) return null;
    console.log('Cigna: Page data scraped ✓');

    setStatus('Loading coverage and financial details from Cigna API...');
    const coverage = await cignaMessage("coverage");
    assertPatientConsistency(fullData, coverage);
    applyCoverageApi(fullData, coverage);
    if (run.cancelled || activeCignaRun !== run) throw new Error("Cigna crawl superseded by a newer run.");
    await crawlProcedureCodes(fullData, run);
    validateCignaNormalization(fullData);
    return fullData;
}

// ══════════════════════════════════════════════════════════════════════════
// PASSIVE BACKGROUND SYNC
// ══════════════════════════════════════════════════════════════════════════

function runCignaLoop() {
    if (!chrome.runtime?.id) return;
    if (activeCignaRun) return;
    const url = window.location.href;
    if (!url.includes('/den/coverage') && !url.includes('dental') && !url.includes('coverage')) return;
    const data = scrapeCignaFull();
    if (!data) return;
    chrome.storage.local.get("audit_context", res => {
        const ctx = res.audit_context || {};
        // Passive page identity is intentionally separate from the authoritative API crawl.
        ctx.cigna_page_context = data;
        chrome.storage.local.set({ audit_context: ctx });
    });
}
setTimeout(runCignaLoop, 4000);

// ══════════════════════════════════════════════════════════════════════════
// AUTO-DOWNLOAD + MESSAGE LISTENER
// ══════════════════════════════════════════════════════════════════════════

function autoDownloadJSON(data) {
    try {
        validateProcedureResultIntegrity(data?.procedures?.results);
        const json  = JSON.stringify(data, null, 2);
        const blob  = new Blob([json], { type: 'application/json' });
        const url   = URL.createObjectURL(blob);
        const name  = data.patient?.name || 'patient';
        const date  = new Date().toISOString().slice(0, 10);
        const fname = `cigna_${name.replace(/\s+/g, '_')}_${date}.json`;
        const a     = document.createElement('a');
        a.href      = url;
        a.download  = fname;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
        console.log('Cigna: Auto-downloaded →', fname);
    } catch (e) {
        console.error('Cigna: Auto-download failed', e);
    }
}

async function clearPreviousCignaStorage() {
    const stored = await chrome.storage.local.get(null);
    const context = stored.audit_context || {};
    if (Object.prototype.hasOwnProperty.call(context, "cigna_data")) {
        delete context.cigna_data;
        if (Object.keys(context).length) await chrome.storage.local.set({ audit_context: context });
        else await chrome.storage.local.remove("audit_context");
    }
    const cacheKeys = Object.keys(stored).filter(key => key.startsWith("cigna_description_"));
    if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
}

async function clearCignaAfterDownload() {
    await clearPreviousCignaStorage();
    await new Promise(resolve => {
        chrome.runtime.sendMessage({ command: "CIGNA_CLEAR_SESSION" }, () => resolve());
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === "START_CRAWL") {
        console.log("Cigna: START_CRAWL received");
        if (activeCignaRun) activeCignaRun.cancelled = true;
        const run = {
            id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            cancelled: false, startedAt: Date.now()
        };
        activeCignaRun = run;
        lockPage();

        clearPreviousCignaStorage().then(() => runCignaCrawl(run)).then(fullData => {
            if (activeCignaRun !== run || run.cancelled) {
                sendResponse({ status: "[!] Previous Cigna crawl was superseded." });
                return;
            }
            if (!fullData) {
                sendResponse({ status: "[!] No data — navigate to the Dental Coverage page first." });
                return;
            }

            validateProcedureResultIntegrity(fullData.procedures.results);
            fullData.data_quality = "full_api";
            autoDownloadJSON(fullData);

            chrome.storage.local.get("audit_context", res => {
                const ctx = res.audit_context || {};
                validateProcedureResultIntegrity(fullData.procedures.results);
                ctx.cigna_data = fullData;
                chrome.storage.local.set({ audit_context: ctx }, async () => {
                    const excl = fullData.procedures.age_gate.excluded_codes || [];
                    await clearCignaAfterDownload();
                    sendResponse({
                        status: `[+] Done — ${fullData.procedures.count} codes scraped. ` +
                                `JSON downloaded automatically. ` +
                                `DOB: ${fullData.procedures.age_gate.patient_dob}. ` +
                                `Excluded: ${excl.length ? excl.join(', ') : 'none'}.`
                    });
                });
            });
        }).catch(err => {
            console.error("Cigna crawl error:", err);
            sendResponse({ status: "[!] Crawl error: " + err.message });
        }).finally(() => {
            if (activeCignaRun === run) {
                activeCignaRun = null;
                unlockPage();
            }
        });

        return true;
    }
});
}
