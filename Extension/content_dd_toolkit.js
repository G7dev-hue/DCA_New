/*
 * content_toolkit.js
 * Delta Dental Office Toolkit benefit extractor
 *
 * No background/service worker is used.
 *
 * IMPORTANT — load this SAME file in both Chrome content-script worlds:
 *
 * "content_scripts": [
 *   {
 *     "matches": ["https://www.dentalofficetoolkit.com/*"],
 *     "js": ["content_toolkit.js"],
 *     "run_at": "document_start",
 *     "world": "MAIN"
 *   },
 *   {
 *     "matches": ["https://www.dentalofficetoolkit.com/*"],
 *     "js": ["content_toolkit.js"],
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
    const RESULT_STORAGE_KEY = "toolkit_data";
    const TARGET_ORIGIN = "https://www.dentalofficetoolkit.com";
    const MEMBER_SEARCH_PATH = "/api/dot-gateway/v02/memberdetail/search";
    const PROCEDURE_SEARCH_PATH = "/api/dot-gateway/v1/benefit/memberbenefits/procedures/search";
    const PROCEDURE_SEARCH_URL = `${TARGET_ORIGIN}${PROCEDURE_SEARCH_PATH}?type=codes`;

    const CATEGORY_CODES = Object.freeze({
        exams: ["D0180", "D0120", "D0140", "D0150"],
        diagnostic: ["D0210", "D0220", "D0230", "D0240", "D0274", "D0330"],
        preventative: ["D1510", "D1110", "D1120", "D1206", "D1351"],
        basicRestorative: ["D2140", "D2331", "D2620"],
        majorRestorative: ["D2740", "D2950", "D2991"],
        endodontics: ["D3347", "D3310", "D3330"],
        periodontics: ["D4260", "D4341", "D4355", "D4381", "D4910"],
        removableProstho: ["D5860", "D5110", "D5740", "D5982"],
        implant: ["D6194", "D6010", "D6056", "D6065"],
        fixedProstho: ["D6245"],
        oralSurgery: ["D7259", "D7140", "D7240"],
        orthodontics: ["D8010", "D8080", "D8090"],
        adjunctive: ["D9430", "D9110", "D9222", "D9239", "D9310", "D9944"]
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
                            status: `[+] Done — Extraction finished. JSON downloaded.`,
                            data_quality: message.data?.["Extraction Metadata"]?.["Data Quality"] || "unknown"
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
                    status: "[!] The MAIN-world extractor did not respond. Load content_toolkit.js in both MAIN and ISOLATED worlds as shown at the top of the file."
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

        if (path === MEMBER_SEARCH_PATH) {
            state.memberSearchRequest = body || state.memberSearchRequest;
            state.memberSearchResponse = responseData;
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



    async function startCrawl(state, nativeFetch, requestId) {
        if (state.activeRun && !state.activeRun.done) {
            state.activeRun.cancelled = true;
        }

        const run = {
            id: makeId(), requestId, cancelled: false, done: false,
            acknowledged: false, startedAt: Date.now()
        };
        state.activeRun = run;

        if (!state.procedureTemplate || !state.procedureHeaders?.authorization) {
            console.info("Delta Toolkit: Attempting automated initial procedure lookup to capture authorization...");
            
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
            let input = inputs.find(i => /procedure|code|search/i.test(i.outerHTML || ""));
            if (!input && inputs.length > 0) input = inputs[inputs.length - 1];

            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a[class*="btn"], div[class*="btn"]'));
            const searchBtn = buttons.find(b => /(search|submit|lookup|find|add|check)/i.test(b.textContent || b.value || b.outerHTML || "") && !b.disabled);
            
            let failureReason = "Unknown";
            
            if (!input) {
                failureReason = "Could not find any input field for procedure code on the page.";
            } else {
                console.info("Delta Toolkit: Found input, dispatching simulated search...");
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(input, "D0120");
                } else {
                    input.value = "D0120";
                }
                
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                
                await sleep(200);
                
                if (searchBtn) {
                    searchBtn.click();
                } else {
                    console.info("Delta Toolkit: No search button found, pressing Enter on the input instead.");
                    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
                }
                
                for (let i = 0; i < 25; i++) {
                    await sleep(300);
                    if (state.procedureTemplate && state.procedureHeaders?.authorization) break;
                }
                
                if (!state.procedureTemplate || !state.procedureHeaders?.authorization) {
                    failureReason = "Simulated search (or Enter key) was triggered, but no API request was intercepted within 7 seconds.";
                }
            }

            if (!state.procedureTemplate || !state.procedureHeaders?.authorization) {
                throw new Error(`Could not automatically capture the API token (${failureReason}). Please type D0120 manually into the page and click Search, then run the extractor again.`);
            }
        }

        try {
            const rawByCode = await fetchAllProcedures(state, nativeFetch, run);
            if (run.cancelled) throw new Error("This extraction was superseded by a newer run.");

            const data = buildFinalOutput(state, rawByCode, run);

            run.done = true;
            postPageMessage("RESULT", { requestId, data });

            // If the ISOLATED-world bridge is present, it acknowledges and handles
            // storage/download. Otherwise the MAIN-world UI still works standalone.
            await sleep(900);
            if (!run.acknowledged) downloadJson(data);
            return data;
        } finally {
            run.done = true;
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
        validateProcedureIntegrity(procedures);
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

        let maxDed = [];
        if (Array.isArray(subscriber.maximumsAndDeductions)) maxDed = subscriber.maximumsAndDeductions;
        else if (subscriber.maximumsAndDeductions && Array.isArray(subscriber.maximumsAndDeductions.accumulators)) maxDed = [subscriber.maximumsAndDeductions];
        
        const accumulators = maxDed.flatMap(m => m.accumulators || []);
        const getAccum = (type, category) => accumulators.find(a => a.accumulatorType === type && a.categoryType === category) || {};
        
        const annualMaxObj = getAccum("Maximum", "General");
        const indDedObj = getAccum("Deductible", "General");
        const orthoDedObj = getAccum("Deductible", "Orthodontic");
        const orthoMaxObj = getAccum("Maximum", "Orthodontic");

        const annualMax = {
            total: moneyValue(annualMaxObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] }, "total") ?? domValue(dom, ["Yearly Maximum", "Annual Maximum"])),
            used: moneyValue(annualMaxObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] }, "used") ?? domValue(dom, ["Yearly Maximum Paid to Date", "Annual Maximum Paid to Date", "Yearly Maximum Used", "Annual Maximum Used"])),
            remaining: moneyValue(annualMaxObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Yearly Maximum Remaining", "Annual Maximum Remaining"]))
        };
        const indDed = {
            total: moneyValue(indDedObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] }, "total") ?? domValue(dom, ["Individual Deductible"])),
            used: moneyValue(indDedObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] }, "used") ?? domValue(dom, ["Individual Deductible Paid to Date", "Individual Deductible Used"])),
            remaining: moneyValue(indDedObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Individual Deductible Remaining"]))
        };
        const famDed = {
            total: moneyValue(indDedObj.familyAmount ?? pickFinancialLeaf(leaves, { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] }, "total") ?? domValue(dom, ["Family Deductible"])),
            used: moneyValue(indDedObj.familyAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] }, "used") ?? domValue(dom, ["Family Deductible Paid to Date", "Family Deductible Used"])),
            remaining: moneyValue(indDedObj.familyAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Family Deductible Remaining"]))
        };
        const orthoDed = {
            total: moneyValue(orthoDedObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] }, "total") ?? domValue(dom, ["Orthodontic Deductible", "Ortho Deductible"])),
            used: moneyValue(orthoDedObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] }, "used") ?? domValue(dom, ["Orthodontic Deductible Paid to Date", "Ortho Deductible Paid to Date"])),
            remaining: moneyValue(orthoDedObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] }, "remaining") ?? domValue(dom, ["Orthodontic Deductible Remaining", "Ortho Deductible Remaining"]))
        };
        const orthoMax = {
            total: moneyValue(orthoMaxObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "total") ?? domValue(dom, ["Orthodontic Maximum", "Ortho Maximum", "Ortho Lifetime Maximum"])),
            used: moneyValue(orthoMaxObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "used") ?? domValue(dom, ["Orthodontic Maximum Paid to Date", "Ortho Maximum Paid to Date"])),
            remaining: moneyValue(orthoMaxObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "remaining") ?? domValue(dom, ["Orthodontic Maximum Remaining", "Ortho Maximum Remaining"]))
        };

        const eligibilityNotes = collectEligibilityNotes(state.supportingApiResponses, procedures);
        const allProcedureText = procedures.map(procedureText).join("\n");
        const missingTooth = sentenceContaining(`${supportText}\n${allProcedureText}`, /missing\s+tooth/i);
        const prepSeat = sentenceContaining(`${supportText}\n${allProcedureText}`, /\b(prep(?:aration)?|seat(?:ing)?)\b/i, /major|crown|prostho/i);
        const dependentAge = findDependentAge(`${supportText}\n${allProcedureText}`) || domValue(dom, ["Dependent Age Limit"]);
        const planYearStart = mineValue(leaves, ["plan", "year", "start"], ["date", "month", "effective"])
            || domValue(dom, ["Starting Month of Plan Year", "Plan Year Start"]);

        // DCA requested that we do NOT invent answers for provisions using heuristic text parsing.
        // We will leave these blank ("N/A") unless they exist strictly as explicit properties in the API.
        // For example, orthoAgeLimit exists in the API's orthoAgeLimitConfig.
        /*
        const deductiblePreventive = deriveDeductibleApplicability(procedures.filter(item => ["preventative"].includes(item.category)), leaves, "prevent");
        const deductibleDiagnostic = deriveDeductibleApplicability(procedures.filter(item => ["exams", "diagnostic"].includes(item.category)), leaves, "diagnostic");
        const waitingPeriod = deriveWaitingPeriod(procedures, subscriber.waitExempted, supportText);
        */

        let actualOrthoAgeLimit = "N/A";
        if (benefitInfo.orthoAgeLimitConfig && benefitInfo.orthoAgeLimitConfig.length > 0) {
            actualOrthoAgeLimit = String(benefitInfo.orthoAgeLimitConfig[0].minorMaxAge || benefitInfo.orthoAgeLimitConfig[0].irsMaxAge || "N/A");
        }

        const provisions = {
            deductible_applies_to_preventive: "N/A", // deductiblePreventive
            deductible_applies_to_diagnostic: "N/A", // deductibleDiagnostic
            waiting_period: "N/A", // waitingPeriod
            waiting_period_applies_to: "N/A", // deriveWaitingAppliesTo(procedures)
            major_services_paid_on_prep_or_seat: "N/A", // prepSeat || "N/A"
            missing_tooth_clause: "N/A", // missingTooth || "N/A"
            dependent_age_limit: "N/A", // dependentAge || "N/A"
            d0120_d0150_share_frequency_with_d0140: "N/A", // sameFrequency(procMap, ["D0120", "D0150", "D0140"])
            permanent_unrestored_molars_only: "N/A", // sealantMolarsOnly(procMap.D1351)
            posterior_composites_downgraded_to_amalgam: "N/A", // posteriorCompositeDowngrade(procMap)
            porcelain_crowns_downgraded_on_posterior_teeth: "N/A", // porcelainCrownDowngrade(procMap.D2740)
            d2950_same_day_as_crown: "N/A", // d2950SameDayCrown(procMap)
            d4341_number_of_quads: "N/A", // numberOfQuads(procMap.D4341)
            d4910_d1110_share_frequency: "N/A", // sameFrequency(procMap, ["D4910", "D1110"])
            ortho_payment_frequency: "N/A", // orthoPaymentFrequency(procMap)
            ortho_age_limit: actualOrthoAgeLimit // natively from API, not heuristic!
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
            patient.isSubscriber ? subscriber.terminationDate : patient.record?.terminationDate,
            patient.isSubscriber ? subscriber.eligibilityEndDate : patient.record?.eligibilityEndDate,
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
            benefitInfo.clientName,
            clientInfo.clientName,
            benefitInfo.subClientName,
            clientInfo.subClientName
        ]);
        
        let mainGroupNum = firstMeaningful([benefitInfo.clientId, clientInfo.clientSpecifiedId]);
        let subGroupNum = firstMeaningful([benefitInfo.subClientId, clientInfo.subClientSpecifiedId]);
        
        let finalGroupNumber = mainGroupNum || subGroupNum;
        if (mainGroupNum && subGroupNum && mainGroupNum !== subGroupNum) {
            finalGroupNumber = `${mainGroupNum}-${subGroupNum}`;
        }
        
        const groupNumber = finalGroupNumber;
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
            "Patient/Subscriber Information": {
                "Patient Name": patientName,
                "Date of Birth of the Patient": valueOrNA(patientDob),
                "Member ID": valueOrNA(memberId),
                "Relation to Subscriber": relationship,
                "Subscriber Name": subscriberName,
                "Date of Birth of the subscriber": valueOrNA(subscriber.dateOfBirth),
                "SSN": valueOrNA(ssn)
            },
            "Insurance Information": {
                "Insurance Name": "Delta Dental",
                "Group Name": valueOrNA(groupName),
                "Group Number": valueOrNA(groupNumber),
                "Fee Schedule": valueOrNA(feeSchedule),
                "Insurance Address": valueOrNA(insuranceAddress),
                "Insurance Phone": valueOrNA(insurancePhone),
                "Provider Network Status": valueOrNA(providerNetworkStatus),
                "Patient Eff Date": valueOrNA(patientEffective),
                "Patient Term Date": valueOrNA(patientTermDate),
                "Starting Month of Plan Year": valueOrNA(planYearStart),
                "Payor ID": valueOrNA(claimInfo.payorId)
            },
            "Eligibility Notes": eligibilityNotes.length ? eligibilityNotes : ["N/A"],
            "Coverage and Maximums": {
                "Yearly Maximum": annualMax.total,
                "Remaining": annualMax.remaining,
                "Individual Deductible Paid to Date": indDed.used,
                "Individual Deductible Remaining": indDed.remaining,
                "Family Deductible Paid to Date": famDed.used,
                "Family Deductible Remaining": famDed.remaining,
                "Deductible Applies to Preventive": provisions.deductible_applies_to_preventive,
                "Deductible Applies to Diagnostic": provisions.deductible_applies_to_diagnostic,
                "Is there a Waiting Period": provisions.waiting_period !== "N/A" && provisions.waiting_period !== "No" ? "Yes" : provisions.waiting_period,
                "Waiting Period": provisions.waiting_period,
                "Applies to": provisions.waiting_period_applies_to,
                "Are Major Services Paid on Prep": provisions.major_services_paid_on_prep_or_seat,
                "Or Seat": provisions.major_services_paid_on_prep_or_seat === "Seat" ? "Yes" : "N/A",
                "Does Missing Tooth Clause Apply?": provisions.missing_tooth_clause,
                "Dependent Age Limit": provisions.dependent_age_limit,
                "Orthodontic Deductible": orthoDed.total,
                "Orthodontic Deductible Paid to Date": orthoDed.used,
                "Orthodontic Maximum": orthoMax.total,
                "Orthodontic Maximum Paid to Date": orthoMax.used
            },
            "General Benefit Categories": buildRequestedFieldMap(procMap, provisions),
            "Extraction Metadata": {
                "Source": "Delta Dental Office Toolkit",
                "Portal": location.hostname,
                "Captured At": new Date().toISOString(),
                "Data Quality": state.memberSearchResponse ? "full_api" : "procedure_api_with_page_fallback"
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
            history_dates: historyDates
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

        map.exams["Do D0120, D0150 Share a frequency with D0140?"] = provisions.d0120_d0150_share_frequency_with_d0140;
        map.preventative["Permanent Un-restored Molars only?"] = provisions.permanent_unrestored_molars_only;
        map.basicRestorative["Posterior composites downgraded to amalgam?"] = provisions.posterior_composites_downgraded_to_amalgam;
        map.majorRestorative["Porcelain crowns downgraded on posterior teeth"] = provisions.porcelain_crowns_downgraded_on_posterior_teeth;
        map.majorRestorative["Can D2950 be done same day as crown?"] = provisions.d2950_same_day_as_crown;
        map.periodontics["Number of quads for code D4341"] = provisions.d4341_number_of_quads;
        map.periodontics["Do D4910 and D1110 share a frequency?"] = provisions.d4910_d1110_share_frequency;
        map.orthodontics["Payment Frequency"] = provisions.ortho_payment_frequency;
        map.orthodontics["Ortho Age Limit"] = provisions.ortho_age_limit;
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
        const allowed = ["authorization", "accept", "content-type", "x-requested-with"];
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
                procedureTemplate: sanitizeForOutput(state.procedureTemplate)
            };
            sessionStorage.setItem("toolkit_capture_v1", JSON.stringify(payload));
        } catch (_) { /* storage may be unavailable */ }
    }

    function hydrateNonSecretState(state) {
        if (state.hydrated) return;
        state.hydrated = true;
        try {
            const saved = safeJsonParse(sessionStorage.getItem("toolkit_capture_v1"));
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
        const filename = `toolkit_${patient}_${date}.json`;
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
