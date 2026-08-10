const clean = (s) => (s || "").trim().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForElement(selector, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const el = document.querySelector(selector);
        if (el) return el;
        await sleep(400);
    }
    return null;
}

function findByText(text, root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (node.textContent.trim() === text) return node.parentElement;
    }
    return null;
}

function setReactInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}


// ══════════════════════════════════════════════════════════════════════════
// PROCEDURE SEARCH NETWORK BRIDGE
// MetLife builds/sends its own request. We only capture the JSON response.
// ══════════════════════════════════════════════════════════════════════════

const METLIFE_PROCEDURE_ENDPOINT = "/md2/v1/metdental/eligibility/procedureSearch";
const METLIFE_PROCEDURE_MESSAGE = "__METLIFE_PROCEDURE_NETWORK_RESPONSE__";
const METLIFE_PROCEDURE_READY = "__METLIFE_PROCEDURE_NETWORK_READY__";

let metlifeProcedureBridgeReady = false;
const metlifeProcedureWaiters = [];

function sameProcedureCodeSet(a, b) {
    const aa = [...new Set((a || []).map(v => String(v).trim().toUpperCase()).filter(Boolean))].sort();
    const bb = [...new Set((b || []).map(v => String(v).trim().toUpperCase()).filter(Boolean))].sort();
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function installProcedureNetworkBridge() {
    window.addEventListener("message", (event) => {
        if (event.source !== window || !event.data) return;

        if (event.data.type === METLIFE_PROCEDURE_READY) {
            metlifeProcedureBridgeReady = true;
            return;
        }

        if (event.data.type !== METLIFE_PROCEDURE_MESSAGE) return;

        const payload = event.data.payload || {};
        const requestCodes = payload?.requestBody?.procedureCodes || [];

        for (let i = metlifeProcedureWaiters.length - 1; i >= 0; i--) {
            const waiter = metlifeProcedureWaiters[i];
            if (!sameProcedureCodeSet(waiter.codes, requestCodes)) continue;

            metlifeProcedureWaiters.splice(i, 1);
            clearTimeout(waiter.timer);

            if (payload.error) waiter.reject(new Error(payload.error));
            else waiter.resolve(payload);
        }
    });

    const injected = document.createElement("script");
    const nonceSource = document.querySelector("script[nonce]");
    if (nonceSource?.nonce) injected.nonce = nonceSource.nonce;

    injected.textContent = `(() => {
        if (window.__METLIFE_PROCEDURE_NETWORK_BRIDGE_INSTALLED__) {
            window.postMessage({ type: ${JSON.stringify(METLIFE_PROCEDURE_READY)} }, "*");
            return;
        }
        window.__METLIFE_PROCEDURE_NETWORK_BRIDGE_INSTALLED__ = true;

        const ENDPOINT = ${JSON.stringify(METLIFE_PROCEDURE_ENDPOINT)};
        const MESSAGE = ${JSON.stringify(METLIFE_PROCEDURE_MESSAGE)};
        const READY = ${JSON.stringify(METLIFE_PROCEDURE_READY)};

        const safeJson = (value) => {
            if (!value) return {};
            if (typeof value === "object") return value;
            try { return JSON.parse(value); } catch (_) { return {}; }
        };

        const publish = (requestBody, responseBody, error = "") => {
            window.postMessage({
                type: MESSAGE,
                payload: {
                    requestBody: safeJson(requestBody),
                    responseBody: responseBody || null,
                    error: error || ""
                }
            }, "*");
        };

        if (typeof window.fetch === "function") {
            const originalFetch = window.fetch;
            window.fetch = async function(input, init = {}) {
                const url = typeof input === "string" ? input : (input?.url || "");
                const method = String(init?.method || input?.method || "GET").toUpperCase();

                let requestBodyText = init?.body || "";
                if (!requestBodyText && typeof Request !== "undefined" && input instanceof Request) {
                    try { requestBodyText = await input.clone().text(); } catch (_) {}
                }

                const response = await originalFetch.apply(this, arguments);

                if (method === "POST" && String(url).includes(ENDPOINT)) {
                    try {
                        const json = await response.clone().json();
                        publish(requestBodyText, json);
                    } catch (err) {
                        publish(requestBodyText, null, "procedureSearch fetch response parse failed: " + (err?.message || err));
                    }
                }

                return response;
            };
        }

        if (typeof XMLHttpRequest !== "undefined") {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url) {
                this.__metlifeProcedureMethod = String(method || "GET").toUpperCase();
                this.__metlifeProcedureUrl = String(url || "");
                return originalOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function(body) {
                const isProcedure =
                    this.__metlifeProcedureMethod === "POST" &&
                    this.__metlifeProcedureUrl.includes(ENDPOINT);

                if (isProcedure) {
                    const requestBodyText = body || "";
                    this.addEventListener("loadend", function() {
                        try {
                            let json = null;
                            if (this.responseType === "json" && this.response) {
                                json = this.response;
                            } else {
                                json = JSON.parse(this.responseText || "{}");
                            }
                            publish(requestBodyText, json);
                        } catch (err) {
                            publish(requestBodyText, null, "procedureSearch XHR response parse failed: " + (err?.message || err));
                        }
                    }, { once: true });
                }

                return originalSend.apply(this, arguments);
            };
        }

        window.postMessage({ type: READY }, "*");
    })();`;

    (document.documentElement || document.head || document.body).appendChild(injected);
    injected.remove();
}

async function ensureProcedureNetworkBridge(timeout = 2500) {
    if (metlifeProcedureBridgeReady) return true;

    installProcedureNetworkBridge();

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (metlifeProcedureBridgeReady) return true;
        await sleep(50);
    }

    throw new Error(
        "MetLife procedure network bridge did not initialize. " +
        "The page may be blocking injected page-world scripts."
    );
}

function waitForProcedureNetworkResponse(codes, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const waiter = {
            codes: [...codes],
            resolve,
            reject,
            timer: null
        };

        waiter.timer = setTimeout(() => {
            const index = metlifeProcedureWaiters.indexOf(waiter);
            if (index >= 0) metlifeProcedureWaiters.splice(index, 1);
            reject(new Error(`Timed out waiting for MetLife procedureSearch network response: ${codes.join(",")}`));
        }, timeout);

        metlifeProcedureWaiters.push(waiter);
    });
}

function mapProcedureNetworkResponse(payload) {
    const items = payload?.responseBody?.procedureSearchItems;
    if (!Array.isArray(items)) {
        throw new Error("MetLife procedureSearch response missing procedureSearchItems");
    }

    return items.map(item => ({
        procedure_code: clean(item?.procedureCode).toUpperCase(),
        description: clean(item?.description),
        frequency_limit: clean(item?.frequencyLimit),
        age_limit: clean(item?.ageLimit),
        late_date_of_service: normalizeLateDate(item?.lastDateOfService) || "—",
        deductible: clean(item?.deductible) || "N/A",
        network_fee: clean(item?.networkFee) || "N/A",
        benefit_level: clean(item?.benefitLevel) || "N/A",
        patient_responsibility: clean(item?.patientResponsibility) || "N/A"
    })).filter(row => row.procedure_code);
}


// 61 codes across 7 batches — chunked into groups of 10 at runtime (site hard limit)
const BATCH_1 = ["D1110", "D4910", "D4355", "D1206", "D1208", "D0274", "D0210", "D0120", "D0150"];
const BATCH_2 = ["D2331", "D2140", "D2740", "D1351", "D1510", "D8080", "D0180", "D0140", "D0240"];
const BATCH_3 = ["D0330", "D0220", "D0230", "D0364", "D0431", "D1120", "D2991", "D2950", "D2620"];
const BATCH_4 = ["D2962", "D6750", "D5110", "D9110", "D9222", "D9243", "D9310", "D9944", "D4341"];
const BATCH_5 = ["D4346", "D4381", "D4260", "D4249", "D3310", "D3330", "D7140", "D7210", "D7240"];
const BATCH_6 = ["D7953", "D6010", "D6056", "D2332", "D6245", "D5860", "D5740", "D5982", "D9430"];
const BATCH_7 = ["D9239", "D3347", "D7259", "D6065", "D6194", "D8010", "D8090", "D9230"];

async function scrapeSubscriberFromDropdown() {
    try {
        // Click the patient name h3 to open dropdown
        const h3 = document.querySelector("h3.patient-name");
        if (!h3) {
            console.warn("[Audit] h3.patient-name not found — skipping");
            return null;
        }

        h3.click();
        await sleep(1200);

        // Find the li containing the Subscriber relation span
        let subscriberEntry = null;
        const spans = document.querySelectorAll(".dropdown-patient-relation");
        for (const span of spans) {
            if (span.innerText.trim() === "Subscriber") {
                subscriberEntry = span.closest("li");
                break;
            }
        }

        if (!subscriberEntry) {
            console.warn("[Audit] Subscriber li not found — closing dropdown");
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await sleep(400);
            return null;
        }

        // Parse the 3 lines: name / relation / "48 | DOB: 05/18/1978 | Male"
        const lines = subscriberEntry.innerText.split("\n").map(l => l.trim()).filter(Boolean);
        const name     = lines[0] || "N/A";
        const relation = lines[1] || "Subscriber";
        const detail   = lines[2] || "";
        const age      = detail.match(/^(\d+)/)?.[1] || "N/A";
        const dob      = detail.match(/DOB:\s*([\d\/]+)/)?.[1] || "N/A";
        const gender   = detail.match(/\|\s*(Male|Female)/i)?.[1]?.trim() || "N/A";

        // Close dropdown without switching patient
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(600);

        const result = { name, relation, age, dob, gender };
        console.log("[Audit] Subscriber scraped:", result);
        return result;

    } catch (err) {
        console.error("[Audit] scrapeSubscriberFromDropdown error (non-fatal):", err);
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// PATIENT INFO
// ══════════════════════════════════════════════════════════════════════════

function scrapePatientInfo() {
    const name = document.querySelector(".patient-name")?.innerText?.trim() ||
        document.querySelector("[class*='patient'] [class*='name']")?.innerText?.trim() || "N/A";
    const cardText = document.querySelector(".card-details, [class*='card-detail'], [class*='member-info']")?.innerText || "";
    return {
        name,
        dob: cardText.match(/DOB:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] || "N/A",
        relationship: cardText.match(/^([^\|]+)/)?.[1]?.trim() || "N/A",
        gender: cardText.match(/\|\s*(Male|Female)\s*/i)?.[1]?.trim() || "N/A"
    };
}


// ══════════════════════════════════════════════════════════════════════════
// PLAN DETAILS
// ══════════════════════════════════════════════════════════════════════════

function scrapePlanDetails() {
    function getLabelValues(labelText) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;

        while ((node = walker.nextNode())) {
            if (clean(node.textContent) !== labelText) continue;

            const labelEl = node.parentElement;
            const detailsColumn = labelEl.closest(".details-column") || labelEl.parentElement;

            // MetLife can place multiple values under one title, for example:
            // Employer / Group # -> CITY OF RACINE, 148620
            const columnValues = Array.from(detailsColumn?.querySelectorAll(".details-value") || [])
                .map(el => clean(el.innerText || el.textContent))
                .filter(Boolean);

            if (columnValues.length) return columnValues;

            // Generic fallback for labels whose values are ordinary sibling elements.
            const siblingValues = [];
            let sibling = labelEl.nextElementSibling;
            while (sibling && !sibling.matches(".details-title")) {
                const value = clean(sibling.innerText || sibling.textContent);
                if (value) siblingValues.push(value);
                sibling = sibling.nextElementSibling;
            }
            if (siblingValues.length) return siblingValues;

            const parentSibling = labelEl.parentElement?.nextElementSibling;
            const fallbackValue = clean(parentSibling?.innerText || parentSibling?.textContent);
            if (fallbackValue) return [fallbackValue];
        }

        return [];
    }

    function getLabelValue(labelText) {
        return getLabelValues(labelText)[0] || "N/A";
    }

    const employerGroupValues = getLabelValues("Employer / Group #");

    return {
        start_date: getLabelValue("Start Date"),
        end_date: getLabelValue("End Date"),
        subscriber_id: getLabelValue("Subscriber SSN or ID"),
        employer_group: employerGroupValues[0] || "N/A",
        group_number: employerGroupValues[1] || "N/A",
        network: getLabelValue("Network"),
        address: getLabelValue("Address")
    };
}

function scrapeProviderInfo() {
    const networkBadge = Array.from(document.querySelectorAll("*")).find(el =>
        /^(in-network|out-of-network)$/i.test((el.innerText || "").trim())
    );

    return {
        provider_network_status: networkBadge ? (networkBadge.innerText || "").trim() : "N/A"
    };
}

// ══════════════════════════════════════════════════════════════════════════
// FINANCIALS
// ══════════════════════════════════════════════════════════════════════════

function findCardByLabel(labelText) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (node.textContent.trim() !== labelText) continue;
        let el = node.parentElement;
        for (let i = 0; i < 10; i++) {  // bleed protection is content-based (siblingLabels check below), not depth — safe to search deeper
            if (!el) break;
            const dollars = (el.innerText || "").match(/\$\s*[\d,]+/g) || [];
            const text = el.innerText || "";
            // Stop if we've absorbed text from a SIBLING card label (Annual/Lifetime/Individual)
            const siblingLabels = ["Annual", "Lifetime", "Individual", "Family"].filter(l => l !== labelText);
            if (siblingLabels.some(l => text.includes(l)) && dollars.length >= 2) break;
            if (dollars.length >= 2) return el;
            el = el.parentElement;
        }
    }
    return null;
}

function parseCardAmounts(container) {
    if (!container) return { remaining: "N/A", used: "N/A", total: "N/A" };
    const text = container.innerText || "";
    return {
        remaining: text.match(/\$\s*[\d,]+\.?\d*\s*remaining/i)?.[0]?.replace(/\s+/g, ' ').trim() || "N/A",
        used: text.match(/\$\s*[\d,]+\.?\d*\s*(?:used|paid)\s*to\s*date/i)?.[0]?.replace(/\s+/g, ' ').trim() || "N/A",
        total: text.match(/\$\s*[\d,]+\.?\d*\s*total/i)?.[0]?.replace(/\s+/g, ' ').trim() || "N/A"
    };
}

function scrapeFinancials() {
    const annualCard = findCardByLabel("Annual");

    // ── Lifetime: check for "no lifetime" message first ──
    const lifetimeCard = findCardByLabel("Lifetime");
    let ortho_lifetime;

    if (!lifetimeCard) {
        ortho_lifetime = { remaining: "0.0", used: "0.0", total: "0.0" };
    } else {
        const lifetimeText = lifetimeCard.innerText || "";
        if (/no lifetime benefit maximum/i.test(lifetimeText)) {
            ortho_lifetime = { remaining: "0.0", used: "0.0", total: "0.0" };
        } else {
            ortho_lifetime = parseCardAmounts(lifetimeCard);
        }
    }
    // ── Family deductible (may not exist for all plans) ──
    const famCard = findCardByLabel("Family");
    const deductible_fam = famCard
        ? parseCardAmounts(famCard)
        : { remaining: "N/A", used: "N/A", total: "N/A" };

    return {
        annual_max:     parseCardAmounts(annualCard),
        ortho_lifetime,
        deductible_ind: parseCardAmounts(findCardByLabel("Individual")),
        deductible_fam,
    };
}


// ══════════════════════════════════════════════════════════════════════════
// COVERED SERVICES
// ══════════════════════════════════════════════════════════════════════════

function scrapeCoveredServices() {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .find(h => h.textContent.trim() === "Covered Services") || findByText("Covered Services");
    let table = null;
    if (heading) {
        const section = heading.closest("section,[class*='section']") || heading.parentElement;
        table = section?.querySelector("table") || heading.parentElement?.nextElementSibling?.querySelector("table");
    }
    if (!table) table = Array.from(document.querySelectorAll("table")).find(t => t.innerText.includes("Procedure Category"));
    if (!table) return [];

    return Array.from(table.querySelectorAll("tr")).slice(1).map(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 2) return null;
        const categoryName = cells[0].querySelector("strong,b")?.innerText?.trim() || cells[0].innerText.split('\n')[0].trim();
        return {
            category: categoryName,
            services: clean(cells[0].innerText).replace(categoryName, "").trim() || "N/A",
            in_network: clean(cells[1]?.innerText) || "N/A",
            out_of_network: clean(cells[2]?.innerText) || "N/A"
        };
    }).filter(r => r && r.category);
}


// ══════════════════════════════════════════════════════════════════════════
// PLAN PROVISIONS
// ══════════════════════════════════════════════════════════════════════════

function scrapeProvisions() {
    // ── 1. Try heading-anchored search (existing logic) ──────────────────
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .find(h => h.textContent.trim().includes("Plan Provisions"))
        || findByText("Plan Provisions");

    let section = null;
    if (heading) {
        let el = heading.nextElementSibling;
        while (el) {
            if ((el.innerText || "").trim().length > 50) { section = el; break; }
            el = el.nextElementSibling;
        }
        if (!section)
            section = heading.closest("[class*='provision'],section") || heading.parentElement;
    }
    if (!section) section = document.querySelector("[class*='provision'],[class*='Provision']");

    // ── 2. If we have a section, try to parse its table ──────────────────
    if (section) {
        const tableRows = section.querySelectorAll("table tr, tbody tr");
        if (tableRows.length) {
            const results = Array.from(tableRows).map(tr => {
                const c = tr.querySelectorAll("td");
                if (c.length < 2) return null;
                return { rule: clean(c[0]?.innerText), value: clean(c[1]?.innerText) };
            }).filter(r => r && r.rule && r.value);
            if (results.length) return results;
        }
    }

    // ── 3. Fallback: scan ALL tables on page for a provisions-like table ──
    //    Identified by known first-column labels from MetLife's Plan Provisions table
    const PROVISION_ANCHORS = [
        "Coverage is selected for",
        "Basis of payment",
        "Waiting Period",
        "Maximum child age",
        "Coordination of Benefits Rule",
        "Alternate Benefits",
        "Orthodontic Coverage",
        "Ortho payment method",
        "Cleanings and Periodontal Maintenance"
    ];

    for (const table of document.querySelectorAll("table")) {
        const rows = Array.from(table.querySelectorAll("tr"));
        const cellTexts = rows.flatMap(r =>
            Array.from(r.querySelectorAll("td")).map(td => clean(td.innerText))
        );
        const matchCount = PROVISION_ANCHORS.filter(a =>
            cellTexts.some(t => t.includes(a))
        ).length;

        if (matchCount >= 3) {
            // This is the provisions table — parse all rows
            return rows.map(tr => {
                const cells = tr.querySelectorAll("td");
                if (cells.length < 2) return null;
                return {
                    rule: clean(cells[0]?.innerText),
                    value: clean(cells[1]?.innerText)
                };
            }).filter(r => r && r.rule && r.value);
        }
    }

    // ── 4. Last-resort: bold-label pairs inside heading's parent ─────────
    if (section) {
        const dts = section.querySelectorAll("dt");
        if (dts.length) return Array.from(dts).map(dt => ({
            rule: clean(dt.innerText),
            value: clean(dt.nextElementSibling?.innerText)
        })).filter(r => r.rule);

        const boldEls = section.querySelectorAll("strong,b,[class*='label'],[class*='key']");
        if (boldEls.length >= 3) {
            const results = Array.from(boldEls).map(el => ({
                rule: clean(el.innerText),
                value: clean((el.parentElement?.innerText || "").replace(el.innerText, "").trim())
                    || clean(el.nextElementSibling?.innerText) || "N/A"
            })).filter(r => r.rule && r.value && r.rule !== r.value);
            if (results.length >= 3) return results;
        }
    }

    return [];
}


// ══════════════════════════════════════════════════════════════════════════
// BUILD PLAN OVERVIEW PAYLOAD
// ══════════════════════════════════════════════════════════════════════════

function buildPlanOverviewPayload() {
    return {
        source: "MetLife Portal - Plan Overview",
        timestamp: new Date().toISOString(),
        patient: scrapePatientInfo(),
        plan_details: scrapePlanDetails(),
        provider_info: scrapeProviderInfo(),
        financials: scrapeFinancials(),
        covered_services: scrapeCoveredServices(),
        provisions: scrapeProvisions()
    };
}


// ══════════════════════════════════════════════════════════════════════════
// CRAWL — PLAN OVERVIEW
// ══════════════════════════════════════════════════════════════════════════

async function waitForText(substring, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if ((document.body.innerText || "").includes(substring)) return true;
        await sleep(300);
    }
    return false;
}

async function crawlPlanOverview() {
    const tabEl = findByText("Maximums, Deductibles & Provisions");
    if (tabEl) {
        tabEl.click();
        await waitForText("Benefit Maximums", 5000);
    }

    const data = buildPlanOverviewPayload();

    return new Promise((resolve) => {
        chrome.storage.local.set({ audit_context: { metlife_data: data } }, () => {
            const got = Object.values(data.financials).some(f => Object.values(f).some(v => v !== "N/A"));
            resolve({ status: got ? `[+] Plan Overview saved (${data.provisions.length} provisions).` : `[!] Saved but financials N/A — stay on Plan Overview and retry.` });
        });
    });
}


// ══════════════════════════════════════════════════════════════════════════
// LOW-LEVEL: run one batch of codes, click Search, scrape table
// ══════════════════════════════════════════════════════════════════════════

async function runOneBatch(codes) {
    await ensureProcedureNetworkBridge();

    let codeInput = document.querySelector("input[aria-label='Procedure Code(s)']") ||
        document.querySelector("input[placeholder*='rocedure']") ||
        document.querySelector("input[placeholder*='ode']") ||
        document.querySelector("input[aria-label*='rocedure']") ||
        findInputNearSearchButton();
    if (!codeInput) codeInput = await waitForElement("input[type='text']:not([readonly])", 6000);
    if (!codeInput) return [];

    const resetBtn = document.querySelector("#search-procedure-form-reset-link") ||
        Array.from(document.querySelectorAll("button,a")).find(el => clean(el.textContent) === "Reset");
    if (resetBtn) {
        resetBtn.click();
        await sleep(500);
    }

    codeInput.focus();
    setReactInputValue(codeInput, "");
    await sleep(150);
    setReactInputValue(codeInput, codes.join(","));
    await sleep(350);

    const searchBtn = document.querySelector(".search-procedure-form__search-btn") ||
        Array.from(document.querySelectorAll("button")).find(b => clean(b.textContent) === "Search" && !b.disabled);
    if (!searchBtn) return [];

    // Register before Search so we cannot miss the matching response.
    const responsePromise = waitForProcedureNetworkResponse(codes, 20000);
    searchBtn.click();

    // Procedure data now comes directly from the network JSON response.
    const networkPayload = await responsePromise;
    const results = mapProcedureNetworkResponse(networkPayload);

    console.log(`[Audit] Network batch: ${codes.join(",")} -> ${results.length} row(s)`);
    for (const row of results) {
        if (row.late_date_of_service && row.late_date_of_service !== "—") {
            console.log(`[Audit] ${row.procedure_code} Last Date Of Service: ${row.late_date_of_service}`);
        }
    }

    return results;
}

function procedureTableSignature() {
    const table = document.querySelector("#procedure-code-data-table table");
    if (!table) return "";
    return Array.from(table.querySelectorAll("tbody tr"))
        .map(row => Array.from(row.querySelectorAll("td")).map(td => clean(td.textContent)).join("|")).join("\n");
}

async function waitForProcedureBatch(codes, beforeSignature = "", timeout = 18000) {
    const wanted = new Set(codes.map(code => code.toUpperCase()));
    const deadline = Date.now() + timeout;
    const started = Date.now();
    let lastSignature = "";
    let stableSince = 0;
    let bestRows = [];

    while (Date.now() < deadline) {
        const table = document.querySelector("#procedure-code-data-table table");
        const rows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];

        if (rows.length) {
            const parsed = scrapeProcedureTable();
            const rowCodes = parsed.map(r => r.procedure_code.toUpperCase()).filter(Boolean);
            const belongsToCurrentBatch = rowCodes.length > 0 && rowCodes.every(code => wanted.has(code));
            const signature = procedureTableSignature();
            const tableChanged = !beforeSignature || signature !== beforeSignature;

            // "showing N of N results" gives us the rendered result count when available.
            const resultHeader = clean(document.querySelector(".procedure-code-data-table__header-text")?.textContent);
            const countMatch = resultHeader.match(/showing\s+(\d+)\s+of\s+(\d+)\s+results?/i);
            const expectedRenderedRows = countMatch ? Number(countMatch[1]) : null;
            const rowCountReady = expectedRenderedRows == null || parsed.length >= expectedRenderedRows;

            if (belongsToCurrentBatch && tableChanged && rowCountReady) {
                // Keep the best observed value for each row. A real date always beats an empty/dash value.
                const previousByCode = new Map(bestRows.map(r => [r.procedure_code, r]));
                bestRows = parsed.map(row => {
                    const previous = previousByCode.get(row.procedure_code);
                    const currentDate = normalizeLateDate(row.late_date_of_service);
                    const previousDate = normalizeLateDate(previous?.late_date_of_service);
                    if (!currentDate && previousDate) {
                        return { ...row, late_date_of_service: previousDate };
                    }
                    return { ...row, late_date_of_service: currentDate || "—" };
                });

                if (signature !== lastSignature) {
                    lastSignature = signature;
                    stableSince = Date.now();
                } else if (!stableSince) {
                    stableSince = Date.now();
                }

                // React can paint the row first and populate Late Date Of Service afterwards.
                // Require the CURRENT result table to remain unchanged for 4 seconds and never
                // return earlier than 5 seconds after Search. This prevents the all-"—" capture.
                const stableFor = Date.now() - stableSince;
                const elapsed = Date.now() - started;
                if (elapsed >= 5000 && stableFor >= 4000) {
                    return bestRows;
                }
            } else {
                // We are still looking at the previous batch or a partially replaced table.
                stableSince = 0;
            }
        }

        await sleep(250);
    }

    // Timeout fallback: return only rows that actually belong to this batch.
    const fallback = scrapeProcedureTable().filter(r => wanted.has(r.procedure_code.toUpperCase()));
    return fallback.length ? fallback : bestRows;
}


// ══════════════════════════════════════════════════════════════════════════
// CRAWL — BENEFIT & COVERAGE  (all batches merged, chunked by 10)
// ══════════════════════════════════════════════════════════════════════════

async function crawlBenefitCoverage(extraCodes = "") {
    const tabEl = findByText("Benefit & Coverage Details");
    if (tabEl) { tabEl.click(); await sleep(2500); }

    // Scrape subscriber — non-fatal, cannot block procedure scraping
    let subscriberInfo = null;
    try {
        subscriberInfo = await scrapeSubscriberFromDropdown();
        console.log("[Audit] Subscriber info:", subscriberInfo);
    } catch (e) {
        console.error("[Audit] Subscriber scrape failed (non-fatal):", e);
    }

    // Save subscriber immediately before batches start
    if (subscriberInfo) {
        await new Promise(resolve => {
            chrome.storage.local.get("audit_context", (res) => {
                const ctx = res.audit_context || {};
                ctx.subscriber_info = subscriberInfo;
                chrome.storage.local.set({ audit_context: ctx }, resolve);
            });
        });
    }

    const extraList = extraCodes
        ? extraCodes.split(",").map(c => c.trim().toUpperCase()).filter(Boolean)
        : [];

    const allCodes = [...new Set([
        ...BATCH_1, ...BATCH_2, ...BATCH_3,
        ...BATCH_4, ...BATCH_5, ...BATCH_6,
        ...BATCH_7, ...extraList
    ])];

    const CHUNK_SIZE = 10;
    const chunks = [];
    for (let i = 0; i < allCodes.length; i += CHUNK_SIZE) {
        chunks.push(allCodes.slice(i, i + CHUNK_SIZE));
    }

    const seen = new Set();
    const allProcedures = [];

    for (let i = 0; i < chunks.length; i++) {
        console.log(`[Audit] Chunk ${i + 1}/${chunks.length}: ${chunks[i].join(",")}`);
        try {
            const batchResults = await runOneBatch(chunks[i]);
            for (const proc of batchResults) {
                if (!seen.has(proc.procedure_code)) {
                    seen.add(proc.procedure_code);
                    allProcedures.push(proc);
                }
            }
        } catch (e) {
            console.error(`[Audit] Chunk ${i + 1} failed:`, e);
        }
        if (i < chunks.length - 1) await sleep(1000);
    }

    return new Promise((resolve) => {
        chrome.storage.local.get("audit_context", (res) => {
            const ctx = res.audit_context || {};
            ctx.subscriber_info = subscriberInfo;
            ctx.benefit_coverage = {
                source: "MetLife Portal - Benefit & Coverage Details",
                timestamp: new Date().toISOString(),
                codes_searched: allCodes,
                extra_codes: extraList,
                procedure_count: allProcedures.length,
                procedures: allProcedures
            };
            chrome.storage.local.set({ audit_context: ctx }, () => {
                resolve({ status: `[+] Scraped ${allProcedures.length} procedures across ${chunks.length} chunk(s).` });
            });
        });
    });
}


// ══════════════════════════════════════════════════════════════════════════
// TABLE & INPUT HELPERS
// ══════════════════════════════════════════════════════════════════════════

function normalizeLateDate(value) {
    const text = clean(value);
    if (!text || /^(?:—|-|N\/?A|NOT AVAILABLE)$/i.test(text)) return "";

    // Portal currently returns MM/DD/YY (for example 02/02/26).
    // Preserve the portal value instead of letting Date() reinterpret it.
    const match = text.match(/\b(\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))\b/);
    return match ? match[1] : text;
}

function getProcedureCell(row, headerId, fallbackIndex) {
    // The MetLife table explicitly links each <td> to its column using headers="...".
    // Prefer that semantic contract; numeric index is only a fallback.
    const semanticCell = row.querySelector(`td[headers="${headerId}"]`);
    if (semanticCell) return clean(semanticCell.textContent || semanticCell.innerText);

    const cells = row.querySelectorAll("td");
    return clean(cells[fallbackIndex]?.textContent || cells[fallbackIndex]?.innerText);
}

function scrapeProcedureTable() {
    // Scope strictly to the Search Procedures result table. The page contains other tables.
    const table = document.querySelector("#procedure-code-data-table table");
    if (!table) return [];

    const rows = table.querySelectorAll("tbody tr");
    if (!rows.length) return [];

    return Array.from(rows).map(row => {
        const procedureCode = getProcedureCell(row, "header-procedurecode", 0).toUpperCase();
        if (!procedureCode) return null;

        const lateDate = normalizeLateDate(
            getProcedureCell(row, "header-latedateofservice", 4)
        );

        return {
            procedure_code: procedureCode,
            description: getProcedureCell(row, "header-description", 1),
            frequency_limit: getProcedureCell(row, "header-frequencylimit", 2),
            age_limit: getProcedureCell(row, "header-agelimit", 3),
            late_date_of_service: lateDate || "—",
            deductible: getProcedureCell(row, "header-deductible", 5) || "N/A",
            network_fee: getProcedureCell(row, "header-networkfee", 6) || "N/A",
            benefit_level: getProcedureCell(row, "header-benefitlevel", 7) || "N/A",
            patient_responsibility: getProcedureCell(row, "header-patientobligation", 8) || "N/A"
        };
    }).filter(Boolean);
}

function findInputNearSearchButton() {
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Search");
    if (!btn) return null;
    let parent = btn.parentElement;
    for (let i = 0; i < 5; i++) {
        if (!parent) break;
        const input = parent.querySelector("input[type='text'],input:not([type])");
        if (input) return input;
        parent = parent.parentElement;
    }
    return null;
}


// ══════════════════════════════════════════════════════════════════════════
// PASSIVE BACKGROUND SYNC
// ══════════════════════════════════════════════════════════════════════════

setInterval(() => {
    if (!chrome.runtime?.id) return;
    if (!(document.body?.innerText || "").includes("Benefit Maximums")) return;
    const data = buildPlanOverviewPayload();
    chrome.storage.local.get("audit_context", (res) => {
        const ctx = res.audit_context || {};
        ctx.metlife_data = data;
        chrome.storage.local.set({ audit_context: ctx });
    });
}, 5000);


// ══════════════════════════════════════════════════════════════════════════
// DOWNLOAD HELPER
// ══════════════════════════════════════════════════════════════════════════

function downloadAuditJSON() {
    chrome.storage.local.get("audit_context", (res) => {
        const data = res.audit_context || {};
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const patient = data?.metlife_data?.patient?.name
            ?.replace(/[^a-z0-9]/gi, "_")?.toLowerCase() || "patient";
        a.download = `${patient}_metlife_audit.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });
}


// ══════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.command === "START_CRAWL") {
        (async () => {
            await crawlPlanOverview();
            const res = await crawlBenefitCoverage("");
            downloadAuditJSON();
            sendResponse({ status: res.status + " JSON downloaded." });
        })();
        return true;
    }

    if (request.command === "CRAWL_PLAN_OVERVIEW") {
        crawlPlanOverview().then(sendResponse).catch(() => sendResponse({ status: "[!] Error." }));
        return true;
    }

    if (request.command === "CRAWL_BENEFIT_COVERAGE") {
        crawlBenefitCoverage(request.extraCodes || "").then(sendResponse).catch(() => sendResponse({ status: "[!] Error." }));
        return true;
    }
});