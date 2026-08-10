/*
 * content_dentaquest.js
 * Delta Dental Office Toolkit benefit extractor
 *
 * No background/service worker is used.
 *
 * IMPORTANT — load this SAME file in both Chrome content-script worlds:
 *
 * "content_scripts": [
 *   {
 *     "matches": ["https://www.dentalofficetoolkit.com/*"],
 *     "js": ["content_dentaquest.js"],
 *     "run_at": "document_start",
 *     "world": "MAIN"
 *   },
 *   {
 *     "matches": ["https://www.dentalofficetoolkit.com/*"],
 *     "js": ["content_dentaquest.js"],
 *     "run_at": "document_start",
 *     "world": "ISOLATED"
 *   }
 * ]
 *
 * The MAIN-world copy captures the portal's authenticated API request and
 * performs the extraction. The ISOLATED-world copy keeps popup messaging and
 * chrome.storage.local working. Both copies are this one file.
 *
 * Usage:
 *   1. Open the member-benefits page.
 *   2. Perform one ordinary procedure-code search in the Toolkit UI.
 *      This lets the script learn the current authenticated request template.
 *   3. Click the floating "Extract Delta Benefits" button, or send
 *      { command: "START_CRAWL" } from the extension popup.
 */

(() => {
    "use strict";

    const EXT_SOURCE = "delta-toolkit-extension";
    const PAGE_SOURCE = "delta-toolkit-page";
    const RESULT_STORAGE_KEY = "dentaquest_data";
    const TARGET_ORIGIN = "https://www.dentalofficetoolkit.com";
    // Member search endpoint from HAR - v02/memberdetail/search is the actual endpoint
    const MEMBER_SEARCH_PATH = "/api/dot-gateway/v02/memberdetail/search";
    // Also accept the v1 path as fallback for compatibility
    const MEMBER_SEARCH_PATH_V1 = "/api/dot-gateway/v1/benefit/memberbenefits/search";
    const PROCEDURE_SEARCH_PATH = "/api/dot-gateway/v1/benefit/memberbenefits/procedures/search";
    const PROCEDURE_SEARCH_URL = `${TARGET_ORIGIN}${PROCEDURE_SEARCH_PATH}?type=codes`;

    const CATEGORY_CODES = Object.freeze({
        EXAMS: ["D0180", "D0120", "D0140", "D0150"],
        DIAGNOSTIC: ["D0210", "D0220", "D0230", "D0240", "D0274", "D0330"],
        PREVENTATIVE: ["D1510", "D1110", "D1120", "D1206", "D1351"],
        "BASIC RESTORATIVE": ["D2140", "D2331", "D2620"],
        "MAJOR RESTORATIVE": ["D2740", "D2950", "D2991"],
        ENDODONTICS: ["D3347", "D3310", "D3330"],
        PERIODONTICS: ["D4260", "D4341", "D4355", "D4381", "D4910"],
        "REMOVABLE PROSTHO": ["D5860", "D5110", "D5740", "D5982"],
        IMPLANT: ["D6194", "D6010", "D6056", "D6065"],
        "FIXED PROSTHO": ["D6245"],
        "ORAL SURGERY": ["D7259", "D7140", "D7240"],
        ORTHODONTICS: ["D8010", "D8080", "D8090"],
        ADJUNCTIVE: ["D9430", "D9110", "D9222", "D9239", "D9310", "D9944"]
    });

    const PROCEDURE_LABELS = Object.freeze({
        D0180: "Perio Consult",
        D0120: "Periodic Exam",
        D0140: "Limited Exam",
        D0150: "Comprehensive Exam",
        D0210: "Full Mouth Xray",
        D0220: "PA",
        D0230: "PA Addtn",
        D0240: "Intraoral - Occlusal Image",
        D0274: "Bitewings",
        D0330: "Panoramic Xray",
        D1510: "Space Maintainer",
        D1110: "Prophylaxis",
        D1120: "Prophylaxis Child",
        D1206: "Fluoride",
        D1351: "Sealants",
        D2140: "Amalgam",
        D2331: "Composite Filling",
        D2620: "Restorative Onlay/Inlay",
        D2740: "Porcelain Crown",
        D2950: "Build up",
        D2991: "D2991",
        D3347: "Retreatment of previous root canal therapy - premolar",
        D3310: "Endo",
        D3330: "Root Canal",
        D4260: "Osseous Surgery",
        D4341: "Scaling & Root Planning",
        D4355: "Full Mouth Debridement",
        D4381: "Arestin",
        D4910: "Perio Maintenance",
        D5860: "Over Denture Complete",
        D5110: "Dentures",
        D5740: "Reline maxillary partial denture (direct)",
        D5982: "Surgical stent",
        D6194: "Implant",
        D6010: "Implant Body",
        D6056: "Implant Abutment",
        D6065: "Implant Crown",
        D6245: "Pontic - porcelain/ceramic",
        D7259: "Nerve dissection",
        D7140: "Simple Extraction",
        D7240: "Impacted Extraction",
        D8010: "Ortho",
        D8080: "Ortho",
        D8090: "Ortho",
        D9430: "Office visit for observation",
        D9110: "Palliative",
        D9222: "Gen Anesthesia",
        D9239: "sedation/analgesia",
        D9310: "Consult",
        D9944: "Occlusal Guard"
    });

    const PROCEDURE_CODES = Object.freeze(Object.values(CATEGORY_CODES).flat());
    const CATEGORY_BY_CODE = Object.freeze(Object.fromEntries(
        Object.entries(CATEGORY_CODES).flatMap(([category, codes]) => codes.map(code => [code, category]))
    ));

    const hasExtensionRuntime = Boolean(
        typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id
    );

    if (hasExtensionRuntime) {
        installIsolatedBridge();
    } else {
        installMainWorldExtractor();
    }

    // =====================================================================
    // ISOLATED WORLD: popup bridge, storage, and download
    // =====================================================================

    function installIsolatedBridge() {
        if (globalThis.__DELTA_TOOLKIT_ISOLATED_INSTALLED__) return;
        globalThis.__DELTA_TOOLKIT_ISOLATED_INSTALLED__ = true;

        const pending = new Map();

        window.addEventListener("message", event => {
            if (event.source !== window || event.origin !== window.location.origin) return;
            const message = event.data;
            if (!message || message.source !== PAGE_SOURCE) return;

            if (message.type === "RESULT") {
                window.postMessage({
                    source: EXT_SOURCE,
                    type: "RESULT_ACK",
                    requestId: message.requestId
                }, window.location.origin);

                persistAndDownload(message.data).then(() => {
                    const wait = pending.get(message.requestId);
                    if (wait) {
                        clearTimeout(wait.timer);
                        pending.delete(message.requestId);
                        wait.sendResponse({
                            status: `[+] Done — ${message.data?.benefit_coverage?.procedure_count || 0} codes extracted. JSON downloaded.`,
                            data_quality: message.data?.data_quality || "unknown"
                        });
                    }
                }).catch(error => {
                    const wait = pending.get(message.requestId);
                    if (wait) {
                        clearTimeout(wait.timer);
                        pending.delete(message.requestId);
                        wait.sendResponse({ status: `[!] Extraction finished, but save failed: ${error.message}` });
                    }
                });
            }

            if (message.type === "STATUS") {
                try {
                    chrome.runtime.sendMessage({ command: "STATUS_UPDATE", status: message.status });
                } catch (e) {}
            }

            if (message.type === "ERROR") {
                const wait = pending.get(message.requestId);
                if (wait) {
                    clearTimeout(wait.timer);
                    pending.delete(message.requestId);
                    wait.sendResponse({ status: `[!] ${message.error || "Delta Toolkit extraction failed."}` });
                }
            }
        });

        chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
            if (request?.command !== "START_CRAWL") return false;

            const requestId = makeId();
            const timer = setTimeout(() => {
                const wait = pending.get(requestId);
                if (!wait) return;
                pending.delete(requestId);
                sendResponse({
                    status: "[!] The MAIN-world extractor did not respond. Load content_dentaquest.js in both MAIN and ISOLATED worlds as shown at the top of the file."
                });
            }, 12000);

            pending.set(requestId, { sendResponse, timer });
            window.postMessage({ source: EXT_SOURCE, type: "START_CRAWL", requestId }, window.location.origin);
            return true;
        });

        async function persistAndDownload(data) {
            await new Promise((resolve, reject) => {
                chrome.storage.local.get("audit_context", result => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    const context = result.audit_context || {};
                    context[RESULT_STORAGE_KEY] = data;
                    chrome.storage.local.set({ audit_context: context }, () => {
                        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                        else resolve();
                    });
                });
            });
            downloadJson(data);
        }
    }

    // =====================================================================
    // MAIN WORLD: API interception and extraction
    // =====================================================================

    function installMainWorldExtractor() {
        if (globalThis.__DELTA_TOOLKIT_MAIN_INSTALLED__) return;
        globalThis.__DELTA_TOOLKIT_MAIN_INSTALLED__ = true;

        const nativeFetch = globalThis.fetch.bind(globalThis);
        const NativeXHR = globalThis.XMLHttpRequest;
        const state = {
            memberSearchRequest: null,
            memberSearchResponse: null,
            procedureTemplate: null,
            procedureHeaders: {},
            procedureResponses: new Map(),
            supportingApiResponses: [],
            activeRun: null,
            statusEl: null,
            buttonEl: null,
            hydrated: false
        };

        hydrateNonSecretState(state);
        interceptFetch(state, nativeFetch);
        interceptXHR(state, NativeXHR);
        installPageMessageBridge(state, nativeFetch);
        // installFloatingUiWhenReady removed to avoid conflicting separate popup

        console.info("Delta Toolkit extractor installed. Perform one normal procedure lookup so the authenticated request template can be learned.");
    }

    function interceptFetch(state, nativeFetch) {
        globalThis.fetch = async function deltaToolkitFetch(input, init = {}) {
            let capture = null;
            try {
                capture = await describeFetchRequest(input, init);
            } catch (error) {
                console.debug("Delta Toolkit: unable to inspect fetch request", error);
            }

            const response = await nativeFetch(input, init);
            if (capture && isToolkitApiUrl(capture.url)) {
                inspectFetchResponse(state, capture, response).catch(error => {
                    console.debug("Delta Toolkit: fetch response inspection skipped", error);
                });
            }
            return response;
        };
    }

    async function describeFetchRequest(input, init) {
        const request = input instanceof Request ? input : null;
        const url = request ? request.url : new URL(String(input), location.href).href;
        const method = String(init.method || request?.method || "GET").toUpperCase();
        const headers = mergeHeaders(request?.headers, init.headers);
        let bodyText = null;

        if (typeof init.body === "string") bodyText = init.body;
        else if (init.body instanceof URLSearchParams) bodyText = init.body.toString();
        else if (!init.body && request && !["GET", "HEAD"].includes(method)) {
            try { bodyText = await request.clone().text(); } catch (_) { /* ignored */ }
        }
        return { url, method, headers, bodyText };
    }

    async function inspectFetchResponse(state, request, response) {
        const clone = response.clone();
        const contentType = clone.headers.get("content-type") || "";
        if (!contentType.includes("json") && !looksLikeRelevantEndpoint(request.url)) return;
        const text = await clone.text();
        const data = safeJsonParse(text);
        if (data !== null) captureApiTransaction(state, request, data, response.status);
    }

    function interceptXHR(state, NativeXHR) {
        if (!NativeXHR?.prototype) return;
        const originalOpen = NativeXHR.prototype.open;
        const originalSetRequestHeader = NativeXHR.prototype.setRequestHeader;
        const originalSend = NativeXHR.prototype.send;

        NativeXHR.prototype.open = function(method, url, ...rest) {
            this.__deltaCapture = {
                method: String(method || "GET").toUpperCase(),
                url: new URL(String(url), location.href).href,
                headers: {},
                bodyText: null
            };
            return originalOpen.call(this, method, url, ...rest);
        };

        NativeXHR.prototype.setRequestHeader = function(name, value) {
            if (this.__deltaCapture) this.__deltaCapture.headers[String(name).toLowerCase()] = String(value);
            return originalSetRequestHeader.call(this, name, value);
        };

        NativeXHR.prototype.send = function(body) {
            const capture = this.__deltaCapture;
            if (capture) {
                if (typeof body === "string") capture.bodyText = body;
                else if (body instanceof URLSearchParams) capture.bodyText = body.toString();

                if (isToolkitApiUrl(capture.url)) {
                    this.addEventListener("load", () => {
                        try {
                            let data = null;
                            if (this.responseType === "json") data = this.response;
                            else if (!this.responseType || this.responseType === "text") data = safeJsonParse(this.responseText);
                            if (data !== null) captureApiTransaction(state, capture, data, this.status);
                        } catch (error) {
                            console.debug("Delta Toolkit: XHR response inspection skipped", error);
                        }
                    }, { once: true });
                }
            }
            return originalSend.call(this, body);
        };
    }

    function captureApiTransaction(state, request, responseData, status) {
        const parsedUrl = new URL(request.url, location.href);
        const body = parseRequestBody(request.bodyText);
        const path = parsedUrl.pathname;

        // Handle the actual member search endpoint from HAR (v02/memberdetail/search)
        // Also accept v1 path as fallback for compatibility
        if (path === MEMBER_SEARCH_PATH || path === MEMBER_SEARCH_PATH_V1) {
            state.memberSearchRequest = body || state.memberSearchRequest;
            state.memberSearchResponse = responseData;
            persistNonSecretState(state);
            setStatus(state, "Member details captured. Run one procedure lookup if you have not already.", "ready");
            return;
        }

        // These endpoints are not observed in current HAR but kept for compatibility
        if (path === "/api/dot-gateway/v1/benefit/memberbenefits/routineprocedures/search") {
            state.routineProceduresResponse = responseData;
            persistNonSecretState(state);
            return;
        }
        if (path === "/api/dot-gateway/v1/benefit/client/search") {
            state.clientSearchResponse = responseData;
            persistNonSecretState(state);
            return;
        }

        if (path === PROCEDURE_SEARCH_PATH) {
            if (body && typeof body === "object") {
                state.procedureTemplate = { ...body };
                state.procedureHeaders = safeReplayHeaders(request.headers);
                const codes = extractCodes(body.procedureCodes);
                if (codes.length === 1) state.procedureResponses.set(codes[0], responseData);
                persistNonSecretState(state);
                setStatus(state, "Authenticated procedure request learned. Ready to extract all codes.", "ready");
            }
            return;
        }

        if (status >= 200 && status < 300 && isRelevantJson(responseData)) {
            const sanitized = sanitizeForOutput(responseData);
            const approximateSize = safeStringify(sanitized).length;
            if (approximateSize <= 1_500_000 && state.supportingApiResponses.length < 80) {
                state.supportingApiResponses.push({
                    endpoint: parsedUrl.pathname,
                    query: parsedUrl.search,
                    captured_at: new Date().toISOString(),
                    response: sanitized
                });
            }
        }
    }

    function installPageMessageBridge(state, nativeFetch) {
        window.addEventListener("message", event => {
            if (event.source !== window || event.origin !== window.location.origin) return;
            const message = event.data;
            if (!message || message.source !== EXT_SOURCE) return;

            if (message.type === "RESULT_ACK" && state.activeRun?.requestId === message.requestId) {
                state.activeRun.acknowledged = true;
                return;
            }

            if (message.type === "START_CRAWL") {
                startCrawl(state, nativeFetch, message.requestId).catch(error => {
                    postPageMessage("ERROR", { requestId: message.requestId, error: error.message });
                });
            }
        });
    }

    function installFloatingUiWhenReady(state, nativeFetch) {
        const install = () => {
            if (!document.documentElement || document.getElementById("delta-toolkit-extractor-ui")) return;

            const root = document.createElement("div");
            root.id = "delta-toolkit-extractor-ui";
            root.style.cssText = [
                "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
                "width:300px", "font:13px/1.4 Arial,sans-serif", "background:#fff",
                "color:#172033", "border:1px solid #9db3c7", "border-radius:10px",
                "box-shadow:0 8px 28px rgba(0,0,0,.22)", "padding:12px"
            ].join(";");

            const title = document.createElement("div");
            title.textContent = "Delta Toolkit Extractor";
            title.style.cssText = "font-weight:700;margin-bottom:6px;color:#075985";

            const status = document.createElement("div");
            status.style.cssText = "min-height:36px;margin-bottom:9px;color:#475569";
            status.textContent = state.procedureTemplate
                ? "Authenticated request learned. Ready."
                : "Run one normal procedure-code lookup first.";

            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Extract Delta Benefits";
            button.style.cssText = [
                "width:100%", "border:0", "border-radius:7px", "padding:9px 12px",
                "font-weight:700", "cursor:pointer", "background:#0e7490", "color:#fff"
            ].join(";");
            button.addEventListener("click", () => {
                const requestId = makeId();
                startCrawl(state, nativeFetch, requestId).catch(error => {
                    setStatus(state, error.message, "error");
                    postPageMessage("ERROR", { requestId, error: error.message });
                });
            });

            root.append(title, status, button);
            document.documentElement.appendChild(root);
            state.statusEl = status;
            state.buttonEl = button;
        };

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", install, { once: true });
        } else install();
    }

    async function startCrawl(state, nativeFetch, requestId) {
        if (state.activeRun && !state.activeRun.done) {
            state.activeRun.cancelled = true;
        }

        const run = {
            id: makeId(), requestId, cancelled: false, done: false,
            acknowledged: false, startedAt: Date.now()
        };
        state.activeRun = run;

        if (!state.procedureTemplate) {
            throw new Error("No authenticated procedure request has been captured. Perform one ordinary procedure-code lookup in the Toolkit, then run the extractor again.");
        }

        if (!state.procedureHeaders || !state.procedureHeaders.authorization || !state.procedureTemplate.headers || !state.procedureTemplate.headers.authorization) {
            setStatus(state, "Refreshing API session token automatically...", "working");
            try {
                await new Promise(resolve => {
                    const searchBtn = Array.from(document.querySelectorAll("button")).find(b => (b.textContent || "").trim() === "Search");
                    if (searchBtn) {
                        searchBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                        searchBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                        searchBtn.click();
                    } else {
                        console.warn("Delta Toolkit: Could not find Search button to refresh token.");
                    }
                    setTimeout(resolve, 1500);
                });
            } catch (err) {
                console.warn("Delta Toolkit: Error clicking dummy search button", err);
            }
        }

        setBusy(state, true);
        setStatus(state, `Starting ${PROCEDURE_CODES.length}-code extraction…`, "working");

        try {
            const rawByCode = await fetchAllProcedures(state, nativeFetch, run);
            if (run.cancelled) throw new Error("This extraction was superseded by a newer run.");

            setStatus(state, "Normalizing member, plan, financial, and procedure details…", "working");
            const data = buildFinalOutput(state, rawByCode, run);
            validateProcedureIntegrity(data.benefit_coverage.procedures);

            run.done = true;
            postPageMessage("RESULT", { requestId, data });
            setStatus(state, `Done — ${PROCEDURE_CODES.length} codes extracted.`, "ready");

            // If the ISOLATED-world bridge is present, it acknowledges and handles
            // storage/download. Otherwise the MAIN-world UI still works standalone.
            await sleep(900);
            if (!run.acknowledged) downloadJson(data);
            return data;
        } finally {
            run.done = true;
            setBusy(state, false);
        }
    }

    async function fetchAllProcedures(state, nativeFetch, run) {
        const results = new Map(state.procedureResponses);
        const errors = new Map();
        const queue = PROCEDURE_CODES.filter(code => !results.has(code));
        let completed = PROCEDURE_CODES.length - queue.length;
        const concurrency = 3;

        const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
            while (queue.length && !run.cancelled) {
                const code = queue.shift();
                try {
                    const response = await fetchProcedureWithRetry(state, nativeFetch, code, run);
                    results.set(code, response);
                } catch (error) {
                    errors.set(code, String(error.message || error));
                    results.set(code, null);
                }
                completed += 1;
                setStatus(state, `Extracting procedure benefits: ${completed}/${PROCEDURE_CODES.length}`, "working");
                await sleep(120 + Math.floor(Math.random() * 140));
            }
        });

        await Promise.all(workers);
        results.__errors = errors;
        return results;
    }

    async function fetchProcedureWithRetry(state, nativeFetch, code, run, attempt = 0) {
        if (run.cancelled) throw new Error("Extraction cancelled.");

        const body = { ...state.procedureTemplate, procedureCodes: code };
        const headers = { ...state.procedureHeaders };
        if (!headers.accept) headers.accept = "application/json, text/plain, */*";
        if (!headers["content-type"]) headers["content-type"] = "application/json";

        let response;
        try {
            response = await nativeFetch(PROCEDURE_SEARCH_URL, {
                method: "POST",
                headers,
                credentials: "include",
                body: JSON.stringify(body)
            });
        } catch (error) {
            if (attempt < 2) {
                await sleep(500 * (2 ** attempt));
                return fetchProcedureWithRetry(state, nativeFetch, code, run, attempt + 1);
            }
            throw new Error(`${code}: network request failed (${error.message})`);
        }

        const text = await response.text();
        const data = safeJsonParse(text);

        if (response.ok && data !== null) return data;
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 700 * (2 ** attempt));
            return fetchProcedureWithRetry(state, nativeFetch, code, run, attempt + 1);
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`${code}: session authorization expired. Run one normal Toolkit code lookup again, then retry.`);
        }
        throw new Error(`${code}: HTTP ${response.status}${text ? ` — ${text.slice(0, 180)}` : ""}`);
    }

    // =====================================================================
    // Output construction
    // =====================================================================

    function buildFinalOutput(state, rawByCode, run) {
        const memberRoot = state.memberSearchResponse || {};
        const subscribers = Array.isArray(memberRoot.subscribers) ? memberRoot.subscribers : [];
        const subscriber = subscribers[0] || {};
        const template = state.procedureTemplate || {};
        const memberSearchRequest = state.memberSearchRequest || {};
        const patient = selectPatient(subscriber, template.memberPersonId);
        const procedureErrors = rawByCode.__errors || new Map();

        const procedures = PROCEDURE_CODES.map(code => normalizeProcedure(
            code,
            rawByCode.get(code),
            procedureErrors.get(code)
        ));
        const procMap = Object.fromEntries(procedures.map(item => [item.procedure_code, item]));

        const supportCorpus = [memberRoot, ...state.supportingApiResponses.map(item => item.response)];
        const supportText = uniqueStrings([
            ...collectStrings(supportCorpus),
            cleanText(document.body?.innerText || "")
        ]).join("\n");
        const leaves = flattenLeaves(supportCorpus);
        const dom = buildDomLabelMap();

        const subscriberName = joinName(subscriber.subscriberFirstName, subscriber.subscriberLastName);
        const patientName = patient.isSubscriber
            ? subscriberName
            : joinName(patient.record.dependentFirstName, patient.record.dependentLastName);
        const patientDob = patient.isSubscriber
            ? subscriber.dateOfBirth
            : patient.record.dateOfBirth;
        const patientEffective = patient.isSubscriber
            ? subscriber.effectiveDate
            : patient.record.eligibilityEffectiveDate;
        const patientStatus = patient.isSubscriber
            ? subscriber.eligibilityStatus
            : patient.record.eligibilityStatus;
        const relationship = patient.isSubscriber
            ? (template.relationshipToSubscriber || "Subscriber")
            : (patient.record.relationshipToSubscriber || template.relationshipToSubscriber || "Dependent");

        const claimInfo = subscriber.claimAddressInfo || {};
        const benefitInfo = subscriber.claimBenefitInfo || {};
        const clientInfo = subscriber.clientInformation || {};
        const preferredNetwork = preferredNetworkName(procedures);

        const annualMax = buildFinancialRecord(leaves, dom, "annual_max");
        const indDed = buildFinancialRecord(leaves, dom, "individual_deductible");
        const famDed = buildFinancialRecord(leaves, dom, "family_deductible");
        const orthoDed = buildFinancialRecord(leaves, dom, "ortho_deductible");
        const orthoMax = buildFinancialRecord(leaves, dom, "ortho_maximum");

        const eligibilityNotes = collectEligibilityNotes(state.supportingApiResponses, procedures);
        const allProcedureText = procedures.map(procedureText).join("\n");
        const missingTooth = sentenceContaining(`${supportText}\n${allProcedureText}`, /missing\s+tooth/i);
        const prepSeat = sentenceContaining(`${supportText}\n${allProcedureText}`, /\b(prep(?:aration)?|seat(?:ing)?)\b/i, /major|crown|prostho/i);
        const dependentAge = findDependentAge(`${supportText}\n${allProcedureText}`) || domValue(dom, ["Dependent Age Limit"]);
        const planYearStart = mineValue(leaves, ["plan", "year", "start"], ["date", "month", "effective"])
            || domValue(dom, ["Starting Month of Plan Year", "Plan Year Start"]);

        const deductiblePreventive = deriveDeductibleApplicability(
            procedures.filter(item => ["PREVENTATIVE"].includes(item.category)),
            leaves,
            "prevent"
        );
        const deductibleDiagnostic = deriveDeductibleApplicability(
            procedures.filter(item => ["EXAMS", "DIAGNOSTIC"].includes(item.category)),
            leaves,
            "diagnostic"
        );

        const provisions = {
            deductible_applies_to_preventive: deductiblePreventive,
            deductible_applies_to_diagnostic: deductibleDiagnostic,
            waiting_period: deriveWaitingPeriod(procedures, subscriber.waitExempted, supportText),
            waiting_period_applies_to: deriveWaitingAppliesTo(procedures),
            major_services_paid_on_prep_or_seat: prepSeat || "N/A",
            missing_tooth_clause: missingTooth || "N/A",
            dependent_age_limit: dependentAge || "N/A",
            d0120_d0150_share_frequency_with_d0140: sameFrequency(procMap, ["D0120", "D0150", "D0140"]),
            permanent_unrestored_molars_only: sealantMolarsOnly(procMap.D1351),
            posterior_composites_downgraded_to_amalgam: posteriorCompositeDowngrade(procMap),
            porcelain_crowns_downgraded_on_posterior_teeth: porcelainCrownDowngrade(procMap.D2740),
            d2950_same_day_as_crown: d2950SameDayCrown(procMap),
            d4341_number_of_quads: numberOfQuads(procMap.D4341),
            d4910_d1110_share_frequency: sameFrequency(procMap, ["D4910", "D1110"]),
            ortho_payment_frequency: orthoPaymentFrequency(procMap),
            ortho_age_limit: orthoAgeLimit(procMap)
        };

        const insuranceAddress = formatAddress(
            claimInfo.claimMailingAddress || claimInfo.inquiryAddress ||
            mineObject(leaves, ["insurance", "address"]) ||
            domValue(dom, ["Insurance Address", "Claims Address"])
        );
        const insurancePhone = firstMeaningful([
            claimInfo.phoneNumber,
            claimInfo.subscriberPhoneNumber,
            mineValue(leaves, ["insurance", "phone"], ["phone", "number"]),
            domValue(dom, ["Insurance Phone", "Carrier Phone", "Phone"])
        ]);
        const patientTermDate = firstMeaningful([
            mineValue(leaves, ["termination", "date"], ["term", "end", "effective"]),
            mineValue(leaves, ["eligibility", "end"], ["date", "term"]),
            domValue(dom, ["Patient Term Date", "Termination Date", "Coverage End Date"])
        ]);
        const ssn = firstMeaningful([
            domValue(dom, ["SSN", "Social Security Number"]),
            strictSsnFromText(document.body?.innerText || "")
        ]);
        const feeSchedule = firstMeaningful([
            mineValue(leaves, ["fee", "schedule"], ["fee", "schedule"]),
            domValue(dom, ["Fee Schedule", "Fee Sched"])
        ]);
        const providerNetworkStatus = firstMeaningful([
            mineValue(leaves, ["provider", "network", "status"], ["network", "status"]),
            domValue(dom, ["Provider Network Status", "Network Status"]),
            preferredNetwork
        ]);

        const groupName = firstMeaningful([
            benefitInfo.subClientName,
            benefitInfo.clientName,
            clientInfo.subClientName,
            clientInfo.clientName
        ]);
        const groupNumber = firstMeaningful([
            benefitInfo.subClientId,
            clientInfo.subClientSpecifiedId,
            benefitInfo.clientId,
            clientInfo.clientSpecifiedId
        ]);
        const planName = firstMeaningful([
            benefitInfo.productName,
            clientInfo.productName,
            benefitInfo.plan,
            clientInfo.planAbbrev
        ]);
        const memberId = firstMeaningful([
            memberSearchRequest.memberId,
            subscriber.alternateId,
            subscriber.memberId
        ]);

        const output = {
            source: "Delta Dental Office Toolkit",
            portal: location.hostname,
            captured_at: new Date().toISOString(),
            data_quality: state.memberSearchResponse ? "full_api" : "procedure_api_with_page_fallback",
            crawl_statistics: {
                requested_codes: PROCEDURE_CODES.length,
                successful_codes: procedures.filter(item => !item.error).length,
                failed_codes: procedures.filter(item => item.error).map(item => item.procedure_code),
                supporting_api_responses: state.supportingApiResponses.length,
                duration_ms: Date.now() - run.startedAt
            },
            summary: {
                insurer: "Delta Dental",
                group_name: groupName,
                group_number: groupNumber,
                plan_name: planName,
                payor_id: valueOrNA(claimInfo.payorId)
            },
            patient: {
                name: patientName,
                dob: valueOrNA(patientDob),
                member_id: valueOrNA(memberId),
                relationship,
                eligibility_status: valueOrNA(patientStatus),
                effective_date: valueOrNA(patientEffective),
                termination_date: valueOrNA(patientTermDate)
            },
            subscriber: {
                name: subscriberName,
                dob: valueOrNA(subscriber.dateOfBirth),
                member_id: valueOrNA(memberId),
                ssn: valueOrNA(ssn)
            },
            plan_details: {
                insurance_name: "Delta Dental",
                group_name: groupName,
                group_number: groupNumber,
                plan_name: planName,
                plan_code: firstMeaningful([benefitInfo.plan, clientInfo.adminPlan, clientInfo.planAbbrev]),
                product_name: firstMeaningful([benefitInfo.productName, clientInfo.productName]),
                fee_schedule: valueOrNA(feeSchedule),
                insurance_address: valueOrNA(insuranceAddress),
                insurance_phone: valueOrNA(insurancePhone),
                provider_network_status: valueOrNA(providerNetworkStatus),
                patient_effective_date: valueOrNA(patientEffective),
                patient_termination_date: valueOrNA(patientTermDate),
                starting_month_of_plan_year: valueOrNA(planYearStart),
                payor_id: valueOrNA(claimInfo.payorId),
                client_id: firstMeaningful([benefitInfo.clientId, clientInfo.clientSpecifiedId]),
                sub_client_id: firstMeaningful([benefitInfo.subClientId, clientInfo.subClientSpecifiedId]),
                network: valueOrNA(preferredNetwork)
            },
            eligibility_notes: eligibilityNotes.length ? eligibilityNotes : ["N/A"],
            financials: {
                annual_max: annualMax,
                deductible_ind: indDed,
                deductible_fam: famDed,
                ortho_deductible: orthoDed,
                ortho_lifetime: orthoMax
            },
            provisions,
            covered_services: buildCoveredServices(procedures),
            benefit_coverage: {
                source: "Delta Toolkit Procedure Benefits API",
                procedure_count: procedures.length,
                procedures
            },
            delta_toolkit: {
                patient_subscriber_information: {
                    patient_name: patientName,
                    patient_dob: valueOrNA(patientDob),
                    member_id: valueOrNA(memberId),
                    relation_to_subscriber: relationship,
                    subscriber_name: subscriberName,
                    subscriber_dob: valueOrNA(subscriber.dateOfBirth),
                    ssn: valueOrNA(ssn)
                },
                insurance_information: {
                    insurance_name: "Delta Dental",
                    group_name: groupName,
                    group_number: groupNumber,
                    fee_schedule: valueOrNA(feeSchedule),
                    insurance_address: valueOrNA(insuranceAddress),
                    insurance_phone: valueOrNA(insurancePhone),
                    provider_network_status: valueOrNA(providerNetworkStatus),
                    patient_effective_date: valueOrNA(patientEffective),
                    patient_termination_date: valueOrNA(patientTermDate),
                    starting_month_of_plan_year: valueOrNA(planYearStart),
                    payor_id: valueOrNA(claimInfo.payorId)
                },
                coverage_and_maximums: {
                    yearly_maximum: annualMax.total,
                    yearly_remaining: annualMax.remaining,
                    individual_deductible_total: indDed.total,
                    individual_deductible_paid_to_date: indDed.used,
                    individual_deductible_remaining: indDed.remaining,
                    family_deductible_total: famDed.total,
                    family_deductible_paid_to_date: famDed.used,
                    family_deductible_remaining: famDed.remaining,
                    orthodontic_deductible: orthoDed.total,
                    orthodontic_deductible_paid_to_date: orthoDed.used,
                    orthodontic_maximum: orthoMax.total,
                    orthodontic_maximum_paid_to_date: orthoMax.used
                },
                requested_field_map: buildRequestedFieldMap(procMap, provisions),
                captured_endpoints: uniqueStrings([
                    MEMBER_SEARCH_PATH,
                    MEMBER_SEARCH_PATH_V1,
                    PROCEDURE_SEARCH_PATH,
                    ...state.supportingApiResponses.map(item => item.endpoint)
                ]),
                raw_supporting_responses: state.supportingApiResponses.map(item => sanitizeForOutput(item)),
                missing_fields: listMissingRequestedFields({
                    patientName, patientDob, memberId, relationship, subscriberName,
                    subscriberDob: subscriber.dateOfBirth, ssn, groupName, groupNumber,
                    feeSchedule, insuranceAddress, insurancePhone, providerNetworkStatus,
                    patientEffective, patientTermDate, planYearStart, payorId: claimInfo.payorId,
                    annualMax, indDed, famDed, orthoDed, orthoMax
                })
            }
        };

        return sanitizeForOutput(output);
    }

    function normalizeProcedure(code, raw, error) {
        if (!Array.isArray(raw)) {
            return {
                procedure_code: code,
                description: PROCEDURE_LABELS[code] || code,
                category: CATEGORY_BY_CODE[code] || "N/A",
                benefit_status: "Unknown",
                benefit_level: "N/A",
                oon_benefit_level: "N/A",
                deductible: "N/A",
                age_limit: "N/A",
                frequency_limit: "N/A",
                waiting_period: "N/A",
                late_date_of_service: "NH",
                history_dates: [],
                number_of_quads: "N/A",
                networks: [],
                error: error || "No API response returned."
            };
        }

        const networkRecords = raw.map(bucket => normalizeNetworkBucket(code, bucket)).filter(Boolean);
        const preferred = choosePreferredNetwork(networkRecords);
        const other = networkRecords.filter(item => item !== preferred);
        const allLimitations = uniqueStrings(networkRecords.flatMap(item => item.limitations));
        const allWaiting = uniqueStrings(networkRecords.flatMap(item => item.waiting_periods));
        const allHistory = uniqueStrings(networkRecords.flatMap(item => item.history_dates));
        const ageLimit = firstMeaningful(networkRecords.map(item => item.age_limit));
        const frequency = firstMeaningful(networkRecords.map(item => item.frequency_limit));
        const deductible = firstMeaningful(networkRecords.map(item => item.deductible));
        const latest = latestDate(allHistory);

        return {
            procedure_code: code,
            description: preferred?.description || PROCEDURE_LABELS[code] || code,
            category: CATEGORY_BY_CODE[code] || preferred?.category || "N/A",
            benefit_status: preferred?.benefit_status || "Unknown",
            benefit_level: preferred?.benefit_level || "N/A",
            oon_benefit_level: other.length
                ? uniqueStrings(other.map(item => `${item.network}: ${item.benefit_level}`)).join(" | ")
                : "N/A",
            deductible: deductible || "N/A",
            age_limit: ageLimit || "N/A",
            frequency_limit: frequency || "N/A",
            waiting_period: allWaiting.length ? allWaiting.join(" | ") : "N/A",
            late_date_of_service: latest || "NH",
            history_dates: allHistory,
            number_of_quads: parseQuads(allLimitations.join(" ")) || "N/A",
            exclusions_and_limitations: allLimitations,
            networks: networkRecords,
            raw_api_response: sanitizeForOutput(raw),
            error: error || null
        };
    }

    function normalizeNetworkBucket(code, bucket) {
        if (!bucket || typeof bucket !== "object") return null;
        const coverages = Array.isArray(bucket.coverages) ? bucket.coverages : [];
        const network = uniqueStrings(Array.isArray(bucket.networks) ? bucket.networks : [bucket.networks]).join(", ") || "N/A";
        const leaf = coverages.find(item => normalizeCode(item?.procedureId || item?.procedure) === code)
            || [...coverages].reverse().find(item => Number(item?.level) === Math.max(...coverages.map(x => Number(x?.level) || 0)))
            || coverages[coverages.length - 1]
            || {};
        const coverage = leaf.coverage || {};
        const percent = normalizePercent(coverage.percent);
        const limitations = uniqueStrings(coverages.flatMap(item => toStringList(item?.exclusionsAndLimitations)));
        const waiting = uniqueStrings(coverages.flatMap(item => toStringList(item?.waitingPeriods)));
        const utilization = coverages.flatMap(item => toArray(item?.utilizationBenefits));
        const historyDates = collectDates(utilization);
        const combinedText = uniqueStrings([...limitations, ...waiting, ...collectStrings(utilization)]).join(" ");
        const notCovered = coverage.childValuesNotCovered === true || /\bnot\s+covered\b/i.test(combinedText);
        const benefitStatus = notCovered || percent === "0%" ? "Not Covered" : (percent !== "N/A" ? "Covered" : "Unknown");

        return {
            network,
            description: PROCEDURE_LABELS[code] || (normalizeCode(leaf.procedure) === code ? code : String(leaf.procedure || code)),
            category: coverages[0]?.procedure || CATEGORY_BY_CODE[code] || "N/A",
            benefit_status: benefitStatus,
            benefit_level: percent,
            copay: coverage.hasCoPay ? moneyValue(coverage.coPayFee) : "N/A",
            medically_necessary: Boolean(coverage.medicallyNecessary || coverage.childValuesMedicallyNecessary),
            deductible: parseDeductible(combinedText),
            age_limit: parseAgeLimit(combinedText),
            frequency_limit: parseFrequency(limitations),
            waiting_periods: waiting,
            limitations,
            history_dates: historyDates,
            utilization_benefits: sanitizeForOutput(utilization),
            coverage_path: sanitizeForOutput(coverages.map(item => ({
                level: item.level,
                procedure: item.procedure,
                procedure_id: item.procedureId,
                coverage: item.coverage,
                exclusions_and_limitations: item.exclusionsAndLimitations,
                waiting_periods: item.waitingPeriods,
                radio_graphs_required: item.radioGraphsRequired,
                remarks_required: item.remarksRequired
            })))
        };
    }

    // =====================================================================
    // Requested field map and business questions
    // =====================================================================

    function buildRequestedFieldMap(procMap, provisions) {
        const map = {};
        for (const [category, codes] of Object.entries(CATEGORY_CODES)) {
            map[category] = {};
            for (const code of codes) {
                map[category][`${PROCEDURE_LABELS[code] || code} (${code})`] = procMap[code] || null;
            }
        }

        map.EXAMS["Do D0120,D0150 Share a frequency with D0140?"] = provisions.d0120_d0150_share_frequency_with_d0140;
        map.PREVENTATIVE["Permanent Un-restored Molars only?"] = provisions.permanent_unrestored_molars_only;
        map["BASIC RESTORATIVE"]["Posterior composites downgraded to amalgam?"] = provisions.posterior_composites_downgraded_to_amalgam;
        map["MAJOR RESTORATIVE"]["Porcelain crowns downgraded on posterior teeth"] = provisions.porcelain_crowns_downgraded_on_posterior_teeth;
        map["MAJOR RESTORATIVE"]["Can D2950 be done same day as crown?"] = provisions.d2950_same_day_as_crown;
        map.PERIODONTICS["Number of quads for the code D4341"] = provisions.d4341_number_of_quads;
        map.PERIODONTICS["Do D4910 and D1110 share a frequency?"] = provisions.d4910_d1110_share_frequency;
        map.ORTHODONTICS["Payment Frequency"] = provisions.ortho_payment_frequency;
        map.ORTHODONTICS["Ortho Age Limit"] = provisions.ortho_age_limit;
        return map;
    }

    function sameFrequency(procMap, codes) {
        const values = codes.map(code => canonicalFrequency(procMap[code]?.frequency_limit));
        if (values.some(value => !value)) return "N/A";
        return new Set(values).size === 1 ? "Yes" : "No";
    }

    function sealantMolarsOnly(proc) {
        const text = procedureText(proc);
        if (!text || text === "N/A") return "N/A";
        const molar = /\bmolars?\b/i.test(text);
        const permanent = /\bpermanent\b/i.test(text);
        const unrestored = /\bun[- ]?restored\b|\bcaries[- ]?free\b|\bnon[- ]?restored\b/i.test(text);
        return molar && permanent && unrestored ? "Yes" : (molar ? "No" : "N/A");
    }

    function posteriorCompositeDowngrade(procMap) {
        const text = `${procedureText(procMap.D2331)} ${procedureText(procMap.D2140)}`;
        if (!text.trim()) return "N/A";
        const alternate = /alternate\s+benefit|least\s+costly\s+alternative|downgrad/i.test(text);
        const amalgam = /amalgam/i.test(text);
        const posterior = /posterior|molar|premolar|back\s+tooth/i.test(text);
        if (alternate && (amalgam || posterior)) return "Yes";
        if (/no\s+alternate\s+benefit|not\s+downgrad/i.test(text)) return "No";
        return "N/A";
    }

    function porcelainCrownDowngrade(proc) {
        const text = procedureText(proc);
        if (!text.trim()) return "N/A";
        const alternate = /alternate\s+benefit|least\s+costly\s+alternative|downgrad/i.test(text);
        const posterior = /posterior|molar|premolar|back\s+tooth/i.test(text);
        const material = /porcelain|ceramic|metal|base\s+metal/i.test(text);
        if (alternate && (posterior || material)) return "Yes";
        if (/no\s+alternate\s+benefit|not\s+downgrad/i.test(text)) return "No";
        return "N/A";
    }

    function d2950SameDayCrown(procMap) {
        const buildUp = procMap.D2950;
        const crown = procMap.D2740;
        if (!buildUp || buildUp.benefit_status === "Not Covered") return "No";
        const text = `${procedureText(buildUp)} ${procedureText(crown)}`;
        if (/not\s+(?:payable|covered).*same\s+day|separate\s+date\s+of\s+service/i.test(text)) return "No";
        if (buildUp.benefit_status === "Covered" && crown?.benefit_status === "Covered") return "Yes";
        return "N/A";
    }

    function numberOfQuads(proc) {
        return parseQuads(procedureText(proc)) || "N/A";
    }

    function orthoPaymentFrequency(procMap) {
        const text = ["D8010", "D8080", "D8090"].map(code => procedureText(procMap[code])).join(" ");
        const sentence = sentenceContaining(text, /payment|installment|monthly|quarterly|frequency/i, /ortho|treatment|case|payment/i);
        return sentence || "N/A";
    }

    function orthoAgeLimit(procMap) {
        return firstMeaningful(["D8010", "D8080", "D8090"].map(code => procMap[code]?.age_limit)) || "N/A";
    }

    // =====================================================================
    // Member, financial, and general-field helpers
    // =====================================================================

    function selectPatient(subscriber, memberPersonId) {
        if (subscriber?.personId && memberPersonId && subscriber.personId === memberPersonId) {
            return { isSubscriber: true, record: subscriber };
        }
        const dependent = toArray(subscriber?.dependents).find(item => item?.personId === memberPersonId);
        if (dependent) return { isSubscriber: false, record: dependent };
        return { isSubscriber: true, record: subscriber || {} };
    }

    function buildFinancialRecord(leaves, dom, kind) {
        const specs = {
            annual_max: { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] },
            individual_deductible: { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] },
            family_deductible: { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] },
            ortho_deductible: { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] },
            ortho_maximum: { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }
        };
        const labels = {
            annual_max: ["Yearly Maximum", "Annual Maximum"],
            individual_deductible: ["Individual Deductible"],
            family_deductible: ["Family Deductible"],
            ortho_deductible: ["Orthodontic Deductible", "Ortho Deductible"],
            ortho_maximum: ["Orthodontic Maximum", "Ortho Maximum", "Ortho Lifetime Maximum"]
        };
        const spec = specs[kind];
        const totalRaw = pickFinancialLeaf(leaves, spec, "total") || domValue(dom, labels[kind]);
        const usedRaw = pickFinancialLeaf(leaves, spec, "used") || domValue(dom, labels[kind].flatMap(label => [`${label} Paid to Date`, `${label} Used`, `${label} Met`]));
        const remainingRaw = pickFinancialLeaf(leaves, spec, "remaining") || domValue(dom, labels[kind].map(label => `${label} Remaining`));
        return {
            total: moneyValue(totalRaw),
            used: moneyValue(usedRaw),
            remaining: moneyValue(remainingRaw)
        };
    }

    function pickFinancialLeaf(leaves, spec, measure) {
        const measures = {
            total: ["total", "amount", "maximum", "max", "limit", "benefit"],
            used: ["used", "paid", "met", "applied", "todate", "accumulated"],
            remaining: ["remaining", "balance", "available", "remain"]
        };
        let best = null;
        for (const leaf of leaves) {
            if (!isFinancialValue(leaf.value)) continue;
            const path = leaf.normalizedPath;
            if (spec.exclude.some(term => path.includes(term))) continue;
            if (!spec.scope.every(group => group.some(term => path.includes(term)))) continue;

            let score = 20;
            const measureMatches = measures[measure].filter(term => path.includes(term)).length;
            if (measure === "total") {
                if (/(remaining|balance|available|used|paid|met|applied)/.test(path)) continue;
                score += measureMatches * 3;
            } else {
                if (!measureMatches) continue;
                score += measureMatches * 5;
            }
            if (leaf.path.length <= 7) score += 2;
            if (!best || score > best.score) best = { score, value: leaf.value };
        }
        return best?.value;
    }

    function deriveDeductibleApplicability(procedures, leaves, categoryHint) {
        const explicit = procedures.map(item => item.deductible).filter(value => value && value !== "N/A");
        if (explicit.some(value => /^yes$/i.test(value))) return "Yes";
        if (explicit.length && explicit.every(value => /^no$/i.test(value))) return "No";

        const value = mineValue(leaves, ["deductible", categoryHint], ["applies", "applicable", "waived"]);
        if (typeof value === "boolean") return value ? "Yes" : "No";
        if (/^(yes|true|applies)$/i.test(String(value || ""))) return "Yes";
        if (/^(no|false|waived|does not apply)$/i.test(String(value || ""))) return "No";
        return "N/A";
    }

    function deriveWaitingPeriod(procedures, waitExempted, supportText) {
        if (waitExempted === true) return "No — member is exempt";
        const values = uniqueStrings(procedures.flatMap(item => item.networks?.flatMap(network => network.waiting_periods || []) || []));
        if (values.length) return values.join(" | ");
        const sentence = sentenceContaining(supportText, /waiting\s+period/i);
        return sentence || "N/A";
    }

    function deriveWaitingAppliesTo(procedures) {
        const affected = procedures.filter(item => item.waiting_period !== "N/A").map(item => item.procedure_code);
        return affected.length ? affected.join(", ") : "N/A";
    }

    function collectEligibilityNotes(supporting, procedures) {
        const notes = [];
        for (const item of supporting) {
            const leaves = flattenLeaves([item.response]);
            for (const leaf of leaves) {
                if (typeof leaf.value !== "string") continue;
                if (/eligib|note|remark|message|restriction|exclusion|limitation|warning/i.test(leaf.normalizedPath)) {
                    const value = cleanText(leaf.value);
                    if (value.length > 2 && value.length < 1200) notes.push(value);
                }
            }
        }
        for (const proc of procedures) notes.push(...toArray(proc.exclusions_and_limitations));
        return uniqueStrings(notes).slice(0, 150);
    }

    function buildCoveredServices(procedures) {
        const grouped = new Map();
        for (const proc of procedures) {
            const category = proc.category || "N/A";
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(proc);
        }
        return [...grouped.entries()].map(([category, items]) => ({
            category,
            procedure_codes: items.map(item => item.procedure_code),
            in_network: modalValue(items.map(item => item.benefit_level).filter(value => value !== "N/A")) || "N/A",
            out_of_network: modalValue(items.map(item => item.oon_benefit_level).filter(value => value !== "N/A")) || "N/A"
        }));
    }

    function listMissingRequestedFields(data) {
        const paths = {
            "Patient Name": data.patientName,
            "Patient DOB": data.patientDob,
            "Member ID": data.memberId,
            "Relation to Subscriber": data.relationship,
            "Subscriber Name": data.subscriberName,
            "Subscriber DOB": data.subscriberDob,
            SSN: data.ssn,
            "Group Name": data.groupName,
            "Group Number": data.groupNumber,
            "Fee Schedule": data.feeSchedule,
            "Insurance Address": data.insuranceAddress,
            "Insurance Phone": data.insurancePhone,
            "Provider Network Status": data.providerNetworkStatus,
            "Patient Effective Date": data.patientEffective,
            "Patient Term Date": data.patientTermDate,
            "Starting Month of Plan Year": data.planYearStart,
            "Payor ID": data.payorId,
            "Yearly Maximum": data.annualMax?.total,
            "Individual Deductible": data.indDed?.total,
            "Family Deductible": data.famDed?.total,
            "Orthodontic Deductible": data.orthoDed?.total,
            "Orthodontic Maximum": data.orthoMax?.total
        };
        return Object.entries(paths).filter(([, value]) => isNA(value)).map(([label]) => label);
    }

    // =====================================================================
    // Parsing and normalization utilities
    // =====================================================================

    function parseRequestBody(text) {
        if (!text || typeof text !== "string") return null;
        const json = safeJsonParse(text);
        if (json !== null) return json;
        try {
            return Object.fromEntries(new URLSearchParams(text).entries());
        } catch (_) {
            return null;
        }
    }

    function extractCodes(value) {
        return uniqueStrings(String(value || "").toUpperCase().match(/D\d{4}/g) || []);
    }

    function safeReplayHeaders(headers) {
        const source = headersToObject(headers);
        const allowed = ["authorization", "accept", "content-type", "x-requested-with", "x-dtpc"];
        const output = {};
        for (const key of allowed) {
            if (source[key]) output[key] = source[key];
        }
        return output;
    }

    function mergeHeaders(...inputs) {
        const result = {};
        for (const input of inputs) Object.assign(result, headersToObject(input));
        return result;
    }

    function headersToObject(input) {
        const output = {};
        if (!input) return output;
        try {
            if (input instanceof Headers) {
                input.forEach((value, key) => { output[key.toLowerCase()] = value; });
            } else if (Array.isArray(input)) {
                for (const [key, value] of input) output[String(key).toLowerCase()] = String(value);
            } else {
                for (const [key, value] of Object.entries(input)) output[String(key).toLowerCase()] = String(value);
            }
        } catch (_) { /* ignored */ }
        return output;
    }

    function isToolkitApiUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            return parsed.origin === TARGET_ORIGIN && parsed.pathname.startsWith("/api/dot-gateway/");
        } catch (_) {
            return false;
        }
    }

    function looksLikeRelevantEndpoint(url) {
        return String(url).includes("/api/dot-gateway/");
    }

    function isRelevantJson(value) {
        return value && (Array.isArray(value) || typeof value === "object");
    }

    function preferredNetworkName(procedures) {
        const values = procedures.flatMap(item => item.networks?.map(network => network.network) || []);
        return values.find(value => /\bppo\b/i.test(value) && !/non[- ]?ppo/i.test(value))
            || values.find(value => /premier/i.test(value))
            || values[0]
            || "N/A";
    }

    function choosePreferredNetwork(records) {
        return records.find(item => /\bppo\b/i.test(item.network) && !/non[- ]?ppo/i.test(item.network))
            || records.find(item => /premier/i.test(item.network))
            || records[0]
            || null;
    }

    function normalizeCode(value) {
        return String(value || "").toUpperCase().match(/D\d{4}/)?.[0] || "";
    }

    function normalizePercent(value) {
        if (value === null || value === undefined || value === "") return "N/A";
        const text = String(value).trim();
        return text.endsWith("%") ? text : `${text}%`;
    }

    function parseFrequency(limitations) {
        const values = uniqueStrings(toArray(limitations).map(cleanText).filter(Boolean));
        const frequency = values.filter(text => /\b(per|every|calendar|rolling|consecutive|once|twice|times?|months?|years?|lifetime|frequency|payable)\b/i.test(text));
        return (frequency.length ? frequency : values).join(" | ") || "N/A";
    }

    function canonicalFrequency(value) {
        const text = String(value || "").trim();
        if (!text || /^N\/?A$/i.test(text)) return "";
        return text.toUpperCase()
            .replace(/D\d{4}/g, "")
            .replace(/[^A-Z0-9]+/g, " ")
            .replace(/\b(PROCEDURE|SERVICE|TREATMENT|ORAL|EXAMINATION|EXAMINATIONS)\b/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseAgeLimit(text) {
        const source = String(text || "");
        const patterns = [
            /ages?\s*(\d{1,2})\s*(?:-|–|to|through)\s*(\d{1,2})/i,
            /(?:from\s+)?age\s*(\d{1,2})\s*(?:-|–|to|through)\s*(\d{1,2})/i,
            /(?:through|up\s+to|under|before)\s+age\s*(\d{1,2})/i,
            /age\s*(\d{1,2})\s*(?:and\s+under|or\s+younger|and\s+younger|or\s+less)/i,
            /age\s*(\d{1,2})\s*(?:and\s+over|or\s+older|and\s+older|\+)/i,
            /(\d{1,2})\s*(?:years?\s+of\s+age)?\s*(?:and\s+under|or\s+younger)/i
        ];
        for (let i = 0; i < patterns.length; i++) {
            const match = source.match(patterns[i]);
            if (!match) continue;
            if (match[2]) return `${match[1]}-${match[2]}`;
            if (i === 4) return `${match[1]}+`;
            return `0-${match[1]}`;
        }
        return "N/A";
    }

    function parseDeductible(text) {
        const source = String(text || "");
        if (/deductible\s+(?:does\s+not|doesn't|not)\s+apply|deductible\s+waived|no\s+deductible/i.test(source)) return "No";
        if (/deductible\s+appl(?:y|ies|icable)|subject\s+to\s+(?:the\s+)?deductible/i.test(source)) return "Yes";
        return "N/A";
    }

    function parseQuads(text) {
        const source = String(text || "");
        let match = source.match(/\b([1-4])\s+(?:quadrants?|quads?)\b/i);
        if (match) return match[1];
        match = source.match(/\b(?:up\s+to|maximum\s+of|no\s+more\s+than)\s+([1-4])\s+(?:quadrants?|quads?)\b/i);
        if (match) return match[1];
        if (/four\s+(?:quadrants?|quads?)/i.test(source)) return "4";
        if (/three\s+(?:quadrants?|quads?)/i.test(source)) return "3";
        if (/two\s+(?:quadrants?|quads?)/i.test(source)) return "2";
        if (/one\s+(?:quadrant|quad)/i.test(source)) return "1";
        return "";
    }

    function collectDates(value) {
        const dates = [];
        const visit = item => {
            if (item === null || item === undefined) return;
            if (typeof item === "string") {
                const matches = item.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{4})\b/g) || [];
                dates.push(...matches);
            } else if (Array.isArray(item)) item.forEach(visit);
            else if (typeof item === "object") Object.values(item).forEach(visit);
        };
        visit(value);
        return uniqueStrings(dates);
    }

    function latestDate(values) {
        let best = null;
        for (const value of toArray(values)) {
            const parsed = parseDateLoose(value);
            if (parsed && (!best || parsed.time > best.time)) best = { time: parsed.time, value };
        }
        return best?.value || "";
    }

    function parseDateLoose(value) {
        const text = String(value || "").trim();
        let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) return { time: Date.UTC(+match[1], +match[2] - 1, +match[3]) };
        match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
        if (match) {
            let year = +match[3];
            if (year < 100) year += 2000;
            return { time: Date.UTC(year, +match[1] - 1, +match[2]) };
        }
        return null;
    }

    function sentenceContaining(text, primary, secondary = null) {
        const sentences = String(text || "").split(/(?<=[.!?])\s+|\n+/).map(cleanText).filter(Boolean);
        return sentences.find(sentence => primary.test(sentence) && (!secondary || secondary.test(sentence))) || "";
    }

    function findDependentAge(text) {
        const sentence = sentenceContaining(text, /dependent/i, /age|coverage\s+ends|eligible/i);
        if (!sentence) return "";
        return parseAgeLimit(sentence) !== "N/A" ? parseAgeLimit(sentence) : sentence;
    }

    function procedureText(proc) {
        if (!proc) return "";
        return uniqueStrings([
            proc.frequency_limit,
            proc.waiting_period,
            ...toArray(proc.exclusions_and_limitations),
            ...toArray(proc.networks).flatMap(item => [
                item.frequency_limit,
                ...toArray(item.limitations),
                ...toArray(item.waiting_periods)
            ])
        ]).join(" ");
    }

    function flattenLeaves(roots) {
        const output = [];
        const visit = (value, path, depth) => {
            if (depth > 18 || value === null || value === undefined) return;
            if (["string", "number", "boolean"].includes(typeof value)) {
                output.push({ path, normalizedPath: normalizePath(path), value });
                return;
            }
            if (Array.isArray(value)) {
                value.slice(0, 1000).forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
                return;
            }
            if (typeof value === "object") {
                for (const [key, item] of Object.entries(value)) visit(item, [...path, key], depth + 1);
            }
        };
        toArray(roots).forEach((root, index) => visit(root, [String(index)], 0));
        return output;
    }

    function normalizePath(path) {
        return path.join(".").toLowerCase().replace(/[^a-z0-9]+/g, "");
    }

    function mineValue(leaves, requiredTerms, preferredTerms = []) {
        const required = toArray(requiredTerms).map(term => String(term).toLowerCase().replace(/[^a-z0-9]/g, ""));
        const preferred = toArray(preferredTerms).map(term => String(term).toLowerCase().replace(/[^a-z0-9]/g, ""));
        let best = null;
        for (const leaf of leaves) {
            if (leaf.value === null || leaf.value === undefined || leaf.value === "") continue;
            if (!required.every(term => leaf.normalizedPath.includes(term))) continue;
            let score = 10 + preferred.filter(term => leaf.normalizedPath.includes(term)).length * 4;
            if (typeof leaf.value === "string" && leaf.value.length < 300) score += 2;
            if (!best || score > best.score) best = { score, value: leaf.value };
        }
        return best?.value || "";
    }

    function mineObject(leaves, requiredTerms) {
        const value = mineValue(leaves, requiredTerms, []);
        return value && typeof value === "object" ? value : "";
    }

    function collectStrings(value) {
        const output = [];
        const visit = (item, depth) => {
            if (depth > 16 || item === null || item === undefined) return;
            if (typeof item === "string") {
                const text = cleanText(item);
                if (text) output.push(text);
            } else if (Array.isArray(item)) item.slice(0, 1500).forEach(x => visit(x, depth + 1));
            else if (typeof item === "object") Object.values(item).forEach(x => visit(x, depth + 1));
        };
        visit(value, 0);
        return output;
    }

    function buildDomLabelMap() {
        const map = new Map();
        const add = (label, value) => {
            const cleanLabel = cleanText(label).replace(/:$/, "");
            const cleanValue = cleanText(value);
            if (!cleanLabel || !cleanValue || cleanLabel.length > 100 || cleanValue === cleanLabel) return;
            const key = cleanLabel.toLowerCase();
            if (!map.has(key) || map.get(key).length < cleanValue.length) map.set(key, cleanValue);
        };

        document.querySelectorAll("tr").forEach(row => {
            const cells = [...row.querySelectorAll(":scope > th, :scope > td")];
            if (cells.length >= 2) add(cells[0].innerText, cells.slice(1).map(cell => cell.innerText).join(" "));
        });
        document.querySelectorAll("dt").forEach(dt => {
            const dd = dt.nextElementSibling;
            if (dd?.tagName?.toLowerCase() === "dd") add(dt.innerText, dd.innerText);
        });
        document.querySelectorAll("label, [class*='label' i]").forEach(label => {
            const sibling = label.nextElementSibling || label.parentElement?.nextElementSibling;
            if (sibling) add(label.innerText, sibling.innerText);
        });
        return map;
    }

    function domValue(map, labels) {
        for (const label of toArray(labels)) {
            const key = cleanText(label).replace(/:$/, "").toLowerCase();
            if (map.has(key)) return map.get(key);
            for (const [candidate, value] of map.entries()) {
                if (candidate === key || candidate.startsWith(`${key} `) || candidate.includes(key)) return value;
            }
        }
        return "";
    }

    function strictSsnFromText(text) {
        const match = String(text || "").match(/(?:SSN|Social\s+Security\s+Number)\s*:?\s*(\*{0,5}\d{3,4}|\d{3}-\d{2}-\d{4}|\d{9})\b/i);
        return match?.[1] || "";
    }

    function formatAddress(value) {
        if (!value) return "";
        if (typeof value === "string") return cleanText(value);
        if (typeof value !== "object") return String(value);
        return uniqueStrings([
            value.address1, value.addressLine1, value.line1, value.street,
            value.address2, value.addressLine2, value.line2,
            value.city, value.state, value.zip, value.zipCode, value.postalCode
        ]).join(", ");
    }

    function moneyValue(value) {
        if (value === null || value === undefined || value === "") return "N/A";
        if (typeof value === "number" && Number.isFinite(value)) {
            return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
        const text = cleanText(String(value));
        if (!text || /^N\/?A$/i.test(text)) return "N/A";
        const match = text.match(/-?\$?\s*[\d,]+(?:\.\d{1,2})?/);
        if (!match) return text;
        const number = Number(match[0].replace(/[$,\s]/g, ""));
        if (!Number.isFinite(number)) return text;
        return `$${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function isFinancialValue(value) {
        if (typeof value === "number") return Number.isFinite(value);
        return typeof value === "string" && /\d/.test(value) && value.length < 100;
    }

    function sanitizeForOutput(value, depth = 0) {
        if (depth > 25) return "[depth limit]";
        if (value === null || value === undefined) return value;
        if (typeof value === "string") return value.length > 30000 ? `${value.slice(0, 30000)}…[truncated]` : value;
        if (["number", "boolean"].includes(typeof value)) return value;
        if (Array.isArray(value)) return value.slice(0, 3000).map(item => sanitizeForOutput(item, depth + 1));
        if (typeof value === "object") {
            const output = {};
            for (const [key, item] of Object.entries(value)) {
                if (/authorization|access.?token|refresh.?token|id.?token|cookie|password|secret|bearer/i.test(key)) continue;
                output[key] = sanitizeForOutput(item, depth + 1);
            }
            return output;
        }
        return String(value);
    }

    function persistNonSecretState(state) {
        try {
            const payload = {
                memberSearchRequest: sanitizeForOutput(state.memberSearchRequest),
                memberSearchResponse: sanitizeForOutput(state.memberSearchResponse),
                procedureTemplate: (function() {
                    const cloned = sanitizeForOutput(state.procedureTemplate);
                    if (cloned && cloned.headers) {
                        delete cloned.headers.authorization;
                        delete cloned.headers.Authorization;
                    }
                    return cloned;
                })()
            };
            sessionStorage.setItem("delta_toolkit_capture_v1", JSON.stringify(payload));
        } catch (_) { /* storage may be unavailable */ }
    }

    function hydrateNonSecretState(state) {
        if (state.hydrated) return;
        state.hydrated = true;
        try {
            const saved = safeJsonParse(sessionStorage.getItem("delta_toolkit_capture_v1"));
            if (!saved) return;
            state.memberSearchRequest = saved.memberSearchRequest || null;
            state.memberSearchResponse = saved.memberSearchResponse || null;
            state.procedureTemplate = saved.procedureTemplate || null;
            // Authorization is intentionally never persisted. A fresh manual lookup
            // is still required after a full page/browser session reload if the API
            // does not accept cookie-only requests.
        } catch (_) { /* ignored */ }
    }

    function postPageMessage(type, payload) {
        window.postMessage({ source: PAGE_SOURCE, type, ...payload }, window.location.origin);
    }

    function setStatus(state, text, mode) {
        if (state.statusEl) {
            state.statusEl.textContent = text;
            state.statusEl.style.color = mode === "error" ? "#b91c1c" : mode === "ready" ? "#166534" : "#475569";
        }
        postPageMessage("STATUS", { status: text, mode });
        console.info(`Delta Toolkit: ${text}`);
    }

    function setBusy(state, busy) {
        if (state.buttonEl) {
            state.buttonEl.disabled = busy;
            state.buttonEl.style.opacity = busy ? ".65" : "1";
            state.buttonEl.style.cursor = busy ? "wait" : "pointer";
        }
    }

    function validateProcedureIntegrity(procedures) {
        if (!Array.isArray(procedures) || procedures.length !== PROCEDURE_CODES.length) {
            throw new Error(`Expected ${PROCEDURE_CODES.length} procedure records, received ${procedures?.length || 0}.`);
        }
        for (let index = 0; index < PROCEDURE_CODES.length; index++) {
            if (procedures[index]?.procedure_code !== PROCEDURE_CODES[index]) {
                throw new Error(`Procedure order mismatch at ${index}: expected ${PROCEDURE_CODES[index]}.`);
            }
        }
        if (new Set(procedures.map(item => item.procedure_code)).size !== PROCEDURE_CODES.length) {
            throw new Error("Duplicate procedure codes found in final output.");
        }
    }

    function downloadJson(data) {
        const patient = String(data?.patient?.name || "patient").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "patient";
        const date = new Date().toISOString().slice(0, 10);
        const filename = `delta_toolkit_${patient}_${date}.json`;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        setTimeout(() => {
            anchor.remove();
            URL.revokeObjectURL(url);
        }, 1500);
    }

    function modalValue(values) {
        const counts = new Map();
        for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    }

    function joinName(first, last) {
        return cleanText([first, last].filter(Boolean).join(" ")) || "N/A";
    }

    function firstMeaningful(values) {
        for (const value of toArray(values)) {
            if (value === null || value === undefined) continue;
            if (typeof value === "object") {
                const formatted = formatAddress(value);
                if (formatted) return formatted;
                continue;
            }
            const text = cleanText(String(value));
            if (text && !/^N\/?A$/i.test(text) && text !== "null" && text !== "undefined") return text;
        }
        return "";
    }

    function valueOrNA(value) {
        return firstMeaningful([value]) || "N/A";
    }

    function isNA(value) {
        if (value && typeof value === "object" && "total" in value) return isNA(value.total);
        const text = String(value ?? "").trim();
        return !text || /^N\/?A$/i.test(text) || text === "-";
    }

    function cleanText(value) {
        return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    function uniqueStrings(values) {
        const output = [];
        const seen = new Set();
        for (const value of toArray(values)) {
            if (value === null || value === undefined) continue;
            const text = typeof value === "string" ? cleanText(value) : safeStringify(value);
            if (!text || text === "null" || text === "[]" || text === "{}" || /^N\/?A$/i.test(text)) continue;
            const key = text.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                output.push(text);
            }
        }
        return output;
    }

    function toArray(value) {
        if (value === null || value === undefined) return [];
        return Array.isArray(value) ? value : [value];
    }

    function toStringList(value) {
        return toArray(value).flatMap(item => {
            if (item === null || item === undefined) return [];
            if (typeof item === "string") return [item];
            if (typeof item === "object") return collectStrings(item);
            return [String(item)];
        });
    }

    function safeJsonParse(text) {
        if (text === null || text === undefined || text === "") return null;
        if (typeof text !== "string") return text;
        try { return JSON.parse(text); } catch (_) { return null; }
    }

    function safeStringify(value) {
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    }

    function makeId() {
        return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();
