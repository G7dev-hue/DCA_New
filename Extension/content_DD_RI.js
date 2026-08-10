// content_ddri.js - DDRI Provider Portal Auditor

const STORAGE_KEYS = {
    AUDIT_CONTEXT: "audit_context",
    PROGRESS: "crawl_progress",
    CURRENT_CARRIER: "current_carrier",
    CACHED_PATIENT_NOTES: "cached_patient_notes"
};

const PROCEDURE_CODES = [
    "D0120", "D0180", "D0140", "D0150", "D0274", "D0210", "D0330",
    "D0220", "D0364", "D0431", "D1110", "D1120", "D1206", "D1351",
    "D1510", "D2391", "D2740", "D2950", "D2962", "D6750", "D5110",
    "D9110", "D9222", "D9230", "D9243", "D9310", "D9944", "D4341",
    "D4355", "D4346", "D4910", "D4381", "D4260", "D4249", "D3310",
    "D3330", "D7140", "D7210", "D7240", "D7953", "D6010", "D6056"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = str => (str || "").replace(/[\n\r\t]/g, " ").replace(/\s+/g, " ").trim();

// Logging helper
function logState(state) {
    console.log(`[DDRI][${state}]`);
}

function broadcastState(state, title, message = "", progress = 0) {
    const payload = {
        carrier: "DDRI",
        state: state,
        stage: 0,
        progress: progress,
        title: title,
        message: message,
        timestamp: Date.now()
    };
    
    // Storage (Persistent)
    chrome.storage.local.set({ [STORAGE_KEYS.PROGRESS]: payload });
    
    // Runtime (Live to Popup)
    chrome.runtime.sendMessage({ type: "PROGRESS_UPDATE", payload: payload }).catch(() => {});
}

async function clearPreviousSession() {
    return new Promise(resolve => {
        chrome.storage.local.remove([STORAGE_KEYS.AUDIT_CONTEXT, STORAGE_KEYS.PROGRESS, "partial_json"], () => {
            resolve();
        });
    });
}

// ------------------------------------------------------------------
// SCRAPING LOGIC
// ------------------------------------------------------------------

function getLabelValue(tableSelector, labelText) {
    const table = document.querySelector(tableSelector);
    if (!table) return "N/A";
    
    const cells = Array.from(table.querySelectorAll('td, th'));
    for (let i = 0; i < cells.length; i++) {
        const text = clean(cells[i].textContent);
        if (text === labelText || text === labelText + ":") {
            for (let j = i + 1; j < cells.length; j++) {
                const val = clean(cells[j].textContent);
                if (val !== "") return val;
            }
        }
    }
    return "N/A";
}

function getEligibilityRow(labelText) {
    const table = document.querySelector('table.Eligibility');
    if (!table) return null;
    const cells = Array.from(table.querySelectorAll('td'));
    for (let i = 0; i < cells.length; i++) {
        if (clean(cells[i].textContent) === labelText) {
            return {
                relationship: clean(cells[i + 1]?.textContent),
                dob: clean(cells[i + 2]?.textContent),
                dates: clean(cells[i + 3]?.textContent)
            };
        }
    }
    return null;
}

function collectPatient() {
    const subName = getLabelValue('.SubscriberProfile', 'Subscriber Name');
    let elig = getEligibilityRow(subName);
    
    if (!elig) {
        const table = document.querySelector('table.Eligibility');
        if (table) {
            const firstDataRow = table.querySelector('tbody tr');
            if (firstDataRow) {
                const cells = firstDataRow.querySelectorAll('td');
                if (cells.length >= 5) {
                    elig = {
                        relationship: clean(cells[2].textContent),
                        dob: clean(cells[3].textContent),
                        dates: clean(cells[4].textContent)
                    };
                }
            }
        }
    }
    
    return {
        name: getLabelValue('.SubscriberProfile', 'Member Name'),
        subscriber_name: subName,
        member_id: getLabelValue('.SubscriberProfile', 'Subscriber ID'),
        dob: elig ? elig.dob : "N/A",
        relationship: elig ? elig.relationship : "N/A"
    };
}

function collectPlan() {
    const dates = getEligibilityRow(getLabelValue('.SubscriberProfile', 'Subscriber Name'))?.dates || "N/A";
    let start = "N/A", end = "N/A";
    if (dates.includes('-')) {
        [start, end] = dates.split('-').map(clean);
    }

    return {
        employer_group: getLabelValue('.SubscriberProfile', 'Group Name'),
        group_number: getLabelValue('.SubscriberProfile', 'Group Number'),
        effective_date: start,
        termination_date: end,
        network_status: getLabelValue('.SubscriberProfile', 'Product Name'),
        coverage_type: getLabelValue('.SubscriberProfile', 'Coverage Type'),
        plan_type: getLabelValue('.SubscriberProfile', 'Plan Type')
    };
}

function collectFinancials() {
    const financials = {
        maximums: [],
        deductibles: []
    };

    // DDRI renders deductible rows in the same main table as maximums and may
    // repeat a simplified deductible total in the OON table. The main table is
    // authoritative because it contains total + used + remaining.
    const maximumKeys = new Set();
    const deductibleByCategory = new Map();

    const categoryKey = value => clean(value).replace(/:\s*$/, '').toLowerCase();
    const isDeductible = value => /\bdeductible\b/i.test(clean(value));
    const isMissing = value => !value || value === "N/A";

    const keepMoreCompleteDeductible = (entry) => {
        const key = categoryKey(entry.category);
        if (!key) return;

        const existing = deductibleByCategory.get(key);
        if (!existing) {
            deductibleByCategory.set(key, entry);
            return;
        }

        // Never replace a real main-table value with the OON fallback's N/A.
        for (const field of ["total", "used", "remaining"]) {
            if (isMissing(existing[field]) && !isMissing(entry[field])) {
                existing[field] = entry[field];
            }
        }
    };

    const maxRows = document.querySelectorAll('tr.DataTableRow, tr.DataTableOddRow');

    for (const row of maxRows) {
        const catCell = row.querySelector('.MaximumsFreqCategory');
        if (!catCell || !row.querySelector('.MaximumsAmount')) continue;

        const category = clean(catCell.textContent).replace(/:\s*$/, '');
        if (!category) continue;

        const entry = {
            category,
            total: clean(row.querySelector('.MaximumsAmount')?.textContent) || "N/A",
            used: clean(row.querySelector('.MaximumsAmountUsed')?.textContent) || "N/A",
            remaining: clean(row.querySelector('.MaximumsAmountAvailable')?.textContent) || "N/A"
        };

        if (isDeductible(category)) {
            keepMoreCompleteDeductible(entry);
            continue;
        }

        const key = [entry.category, entry.total, entry.used, entry.remaining]
            .map(value => clean(value).toLowerCase())
            .join('\u0000');
        if (!maximumKeys.has(key)) {
            maximumKeys.add(key);
            financials.maximums.push(entry);
        }
    }

    // OON deductible values are fallback-only. If the main table already gave
    // us Individual/Family deductible values, do not create a duplicate row.
    const oonTables = document.querySelectorAll('.OONTbl table');
    for (const table of oonTables) {
        for (const row of table.querySelectorAll('tr')) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            const category = clean(cells[0].textContent).replace(/:\s*$/, '');
            if (!category || !isDeductible(category)) continue;

            keepMoreCompleteDeductible({
                category,
                total: clean(cells[1].textContent) || "N/A",
                used: "N/A",
                remaining: "N/A"
            });
        }
    }

    financials.deductibles = Array.from(deductibleByCategory.values());
    return financials;
}

function collectFrequencies() {
    const freqs = [];
    const rows = document.querySelectorAll('tr.DataTableRow, tr.DataTableOddRow');
    for (const row of rows) {
        const catCell = row.querySelector('.MaximumsFreqCategory');
        const freqAmtCell = row.querySelector('.FrequencyAmount');
        if (catCell && freqAmtCell) {
            freqs.push({
                category: clean(catCell.textContent),
                used_count: clean(freqAmtCell.textContent) || "N/A",
                next_eligible: clean(row.querySelector('.FrequenciesNextElig')?.textContent) || "N/A"
            });
        }
    }
    return freqs;
}

function collectProvisions() {
    const provisions = [];
    const benefitDiv = document.getElementById('benefits');
    if (!benefitDiv) return provisions;

    const blocks = Array.from(benefitDiv.querySelectorAll('p, div.redBackgroundTextAlignedLeft, .Disclaimer'));
    for (const block of blocks) {
        const text = clean(block.textContent);
        if (text.includes("missing tooth clause")) {
            provisions.push({ rule: "Missing Tooth Clause", value: text });
        } else if (text.includes("Dependent children are covered")) {
            provisions.push({ rule: "Dependent Age Limit", value: text });
        } else if (block.classList.contains('Disclaimer')) {
            provisions.push({ rule: "Disclaimer", value: text });
        }
    }
    return provisions;
}

function collectBenefitCategories() {
    const categories = [];
    const benefitDiv = document.getElementById('benefits');
    if (!benefitDiv) return categories;

    const table = benefitDiv.querySelector('table');
    if (!table) return categories;

    let currentCat = null;
    const rows = Array.from(table.querySelectorAll('tr'));
    
    for (const row of rows) {
        if (row.classList.contains('TRhBEN')) {
            currentCat = {
                category: clean(row.textContent),
                services: []
            };
            categories.push(currentCat);
        } else if (row.classList.contains('DataTableRow') || row.classList.contains('DataTableOddRow')) {
            if (!currentCat) continue;
            const cells = row.querySelectorAll('td');
            if (cells.length >= 5) {
                currentCat.services.push({
                    name: clean(cells[1].textContent),
                    coverage: clean(cells[2].textContent).replace('Deductible Applies', '').trim(),
                    deductible_applies: cells[2].innerHTML.includes('ICON_DeductibleSM.png') ? "Yes" : "No",
                    age_limit: clean(cells[3].textContent),
                    frequency: clean(cells[4].textContent)
                });
            }
        }
    }
    return categories;
}

function getHiddenParams() {
    return {
        memberId: document.getElementById('MemberId')?.value || "",
        groupNumber: document.getElementById('GroupNumber')?.value || "",
        divisionNumber: document.getElementById('DivisionNumber')?.value || "",
        effectiveDate: document.getElementById('SelectedEffectiveDate')?.value || ""
    };
}

async function fetchProcedure(code, params) {
    const rawCode = code.replace(/^D/i, '');
    let procData = null;
    const txt = el => (el?.textContent || '').replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
    
    try {
        const response = await fetch('/BenefitsAndClaims/GetProcedureCode', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'x-validation-header': 'DDRI'
            },
            body: `Code=${rawCode}`
        });
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const table = doc.getElementById('ProcedureCodeSearchResult');
        
        if (table) {
            const rows = table.querySelectorAll('tr');
            if (rows.length >= 2) {
                const cells = rows[1].querySelectorAll('td');
                if (cells.length >= 6) {
                    procData = {
                        procedure_code: code,
                        description: txt(cells[1]),
                        coverage_percentage: txt(cells[2]),
                        deductible_applies: txt(cells[3]),
                        waiting_period: txt(cells[4]),
                        alternate_benefit: txt(cells[5]),
                        frequency: "N/A",
                        age_limit: "N/A",
                        history: []
                    };
                }
            }
        }
    } catch (e) {
        console.error(`Error fetching coverage for ${code}:`, e);
    }

    if (!procData) return null;

    try {
        const reqBody = `StartDate=7&ProcedureCode=${rawCode}&ToothNumber=&MemberId=${params.memberId}&GroupNumber=${params.groupNumber}&DivisionNumber=${params.divisionNumber}`;
        const response = await fetch('/BenefitsAndClaims/GetToothHistory', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'x-validation-header': 'DDRI'
            },
            body: reqBody
        });
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const table = doc.querySelector('.ToothHistorySearchResults');
        
        if (table) {
            const rows = table.querySelectorAll('tbody tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 5) {
                    const svc_date = txt(cells[2]);
                    if (svc_date && svc_date !== 'NA' && svc_date !== '' && svc_date !== '\u00a0') {
                        procData.history.push({
                            service_date: svc_date,
                            tooth_number: txt(cells[3]),
                            tooth_surface: txt(cells[4]),
                            history_notes: "NA"
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error(`Error fetching history for ${code}:`, e);
    }

    return procData;
}

async function collectProcedures(requestedCodes = null) {
    const results = [];
    const params = getHiddenParams();
    
    if (!params.memberId) {
        throw new Error("No MemberId found. Cannot crawl procedures.");
    }

    const BATCH_SIZE = 10;
    const codes = requestedCodes || PROCEDURE_CODES;
    
    const benefitCats = collectBenefitCategories();
    const findLimits = (keywords) => {
        for (const cat of benefitCats) {
            for (const svc of cat.services) {
                const s = svc.name.toLowerCase();
                if (keywords.some(kw => s.includes(kw))) {
                    return { freq: svc.frequency, age: svc.age_limit };
                }
            }
        }
        return { freq: "N/A", age: "N/A" };
    };

    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
        const batch = codes.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(codes.length / BATCH_SIZE);
        // Procedure crawling occupies the long middle section of the overall crawl.
        const pct = 40 + Math.round((i / codes.length) * 50);
        const codeRange = batch.length === 1 ? batch[0] : `${batch[0]} - ${batch[batch.length - 1]}`;
        
        broadcastState(
            "FETCHING PROCEDURES",
            "Fetching Procedure Benefits",
            `Batch ${batchNum} of ${totalBatches} • ${codeRange} • ${batch.length} code${batch.length === 1 ? "" : "s"}`,
            pct
        );
        
        const batchPromises = batch.map(async (code) => {
            const data = await fetchProcedure(code, params);
            if (data) {
                let limits = { freq: "N/A", age: "N/A" };
                if (code === "D0120" || code === "D0150" || code === "D0180") limits = findLimits(['oral exam']);
                else if (code === "D1110" || code === "D1120" || code === "D4910") limits = findLimits(['cleaning', 'periodontal maintenance']);
                else if (code === "D1206") limits = findLimits(['fluoride']);
                else if (code === "D1351") limits = findLimits(['sealant']);
                else if (code === "D1510") limits = findLimits(['space maintainer']);
                else if (code === "D2391" || code === "D2140") limits = findLimits(['amalgam', 'composite']);
                else if (code === "D2740") limits = findLimits(['crowns over natural teeth']);
                else if (code === "D8080" || code.startsWith("D8")) limits = findLimits(['orthodontic', 'braces']);
                
                data.frequency = limits.freq;
                data.age_limit = limits.age;
            }
            return data;
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(r => { if (r) results.push(r); });

        const completed = Math.min(i + batch.length, codes.length);
        const completedPct = 40 + Math.round((completed / codes.length) * 50);
        broadcastState(
            "FETCHING PROCEDURES",
            "Procedure Benefits In Progress",
            `${completed} of ${codes.length} procedure codes checked`,
            completedPct
        );
        
        if (i + BATCH_SIZE < codes.length) {
            await sleep(150);
        }
    }
    
    return results;
}

function generateJSON(auditData) {
    return {
        ...auditData,
        ddri_data: true
    };
}

function generatePatientNotesJSON(auditData) {
    const getFin = (catLower) => {
        if (!auditData.financials) return "";
        for (const item of (auditData.financials.maximums || [])) {
            if (item.category.toLowerCase().includes(catLower)) return item.used || "";
        }
        return "";
    };

    const getHistory = (code) => {
        if (!auditData.benefit_coverage || !auditData.benefit_coverage.procedures) return "";
        const proc = auditData.benefit_coverage.procedures.find(p => p.procedure_code === code);
        if (!proc || !proc.history || proc.history.length === 0) return "";
        const sorted = [...proc.history].sort((a, b) => new Date(b.service_date) - new Date(a.service_date));
        return sorted[0].service_date;
    };

    return {
        "appointment_date": "",
        "verified_by": "",
        "verification_date": new Date().toLocaleDateString(),
        "eligibility_status": auditData.patient?.eligibility_status || "",
        "carrier": "DDRI",
        "primary_or_secondary": "",
        "plan_type": auditData.patient?.plan_type || "",
        "patient_assigned_to_office": "",

        "individual_maximum_used": getFin("annual max"),
        "ortho_maximum_used": getFin("orthodontic"),

        "history_periodic_exam_d0120": getHistory("D0120"),
        "history_comp_exam_d0150": getHistory("D0150"),
        "history_prophy_d1110": getHistory("D1110"),
        "history_perio_maint_d4910": getHistory("D4910"),
        "history_fmd_d4355": getHistory("D4355"),
        "history_fluoride_d1206_d1208": getHistory("D1206") || getHistory("D1208"),
        "history_xray_d0274": getHistory("D0274"),
        "history_xray_d0210": getHistory("D0210")
    };
}

async function downloadJSON(data) {
    return new Promise(resolve => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const patient = data?.patient?.name?.replace(/[^a-z0-9]/gi, "_")?.toLowerCase() || "patient";
        a.download = `${patient}_ddri_audit.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setTimeout(resolve, 500);
    });
}

function validatePage() {
    return !!document.querySelector('.SubscriberProfile');
}

async function clearPreviousSession(clearCachedNotes = true) {
    const keysToClear = [STORAGE_KEYS.PROGRESS, STORAGE_KEYS.AUDIT_CONTEXT, 'crawl_progress', 'partial_json', 'audit_context'];
    if (clearCachedNotes) {
        keysToClear.push(STORAGE_KEYS.CACHED_PATIENT_NOTES);
        keysToClear.push('cached_patient_notes');
    }
    const safeKeys = keysToClear.filter(Boolean);
    await new Promise(resolve => chrome.storage.local.remove(safeKeys, resolve));
}

let isCrawling = false;
let timeoutHandle = null;

function resetCacheTimeout() {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(async () => {
        await clearPreviousSession(true);
        console.log("[DDRI] Cache timeout expired. Cleaned up.");
    }, 60000); // 60 seconds
}

async function startCrawl() {
    if (isCrawling) return;
    isCrawling = true;
    try {
        await clearPreviousSession(true);
        logState("STARTING");
        broadcastState("STARTING", "Initializing RI Crawl", "Preparing scraper...", 2);
        
        const auditData = {};
        
        logState("COLLECTING PATIENT");
        broadcastState("COLLECTING PATIENT", "Collecting Patient Data", "Extracting subscriber info...", 10);
        auditData.patient = collectPatient();
        
        logState("COLLECTING PLAN");
        broadcastState("COLLECTING PLAN", "Collecting Plan Details", "Extracting plan limits...", 20);
        auditData.plan_details = collectPlan();
        
        logState("COLLECTING FINANCIALS");
        broadcastState("COLLECTING FINANCIALS", "Collecting Financials", "Extracting deductibles and maximums...", 30);
        auditData.financials = collectFinancials();
        
        logState("COLLECTING BENEFIT CATEGORIES");
        broadcastState("COLLECTING BENEFIT CATEGORIES", "Collecting Benefit Categories", "Reading plan benefit table...", 35);
        auditData.benefit_categories = collectBenefitCategories();
        
        logState("FETCHING PROCEDURES");
        broadcastState("FETCHING PROCEDURES", "Starting Procedure Checks", `${PROCEDURE_CODES.length} procedure codes queued`, 40);
        auditData.benefit_coverage = { procedures: await collectProcedures() };
        
        logState("GENERATING JSON");
        broadcastState("GENERATING JSON", "Preparing Audit JSON", "Combining patient, plan, financial and procedure data...", 92);
        const finalJson = generateJSON(auditData);
        const patientNotes = generatePatientNotesJSON(auditData);
        
        await new Promise(resolve => chrome.storage.local.set({ 
            [STORAGE_KEYS.AUDIT_CONTEXT]: finalJson,
            [STORAGE_KEYS.CACHED_PATIENT_NOTES]: patientNotes 
        }, resolve));
        
        logState("INITIATING DOWNLOAD");
        broadcastState("DOWNLOADING", "Downloading Audit JSON", "The RI crawl is complete; saving the file...", 97);
        await downloadJSON(finalJson);
        
        logState("CLEANUP");
        await clearPreviousSession(false); // Keep cached_patient_notes for subsequent manual download
        resetCacheTimeout();
        
        logState("COMPLETE");
        broadcastState("COMPLETE", "RI Crawl Complete", "Audit JSON saved successfully.", 100);
        
    } catch (err) {
        logState("FAILED");
        broadcastState("FAILED", "Audit Failed", err.message);
        await clearPreviousSession(true);
    } finally {
        isCrawling = false;
    }
}

async function startLightweightCrawl() {
    if (isCrawling) return;
    isCrawling = true;
    try {
        await clearPreviousSession(true);
        logState("STARTING LIGHTWEIGHT");
        broadcastState("STARTING", "Initializing Patient JSON...");
        
        const auditData = {};
        
        auditData.patient = collectPatient();
        auditData.plan_details = collectPlan();
        auditData.financials = collectFinancials();
        
        const requiredCodes = ["D0120", "D0150", "D1110", "D4910", "D4355", "D1206", "D1208", "D0274", "D0210"];
        auditData.benefit_coverage = { procedures: await collectProcedures(requiredCodes) };
        
        const patientNotes = generatePatientNotesJSON(auditData);
        
        broadcastState("DOWNLOADING", "Downloading Patient JSON...");
        await downloadJSON(patientNotes);
        
        await clearPreviousSession(true);
        
        broadcastState("COMPLETE", "Download Complete", "Patient JSON Saved");
    } catch (err) {
        broadcastState("FAILED", "Audit Failed", err.message);
        await clearPreviousSession(true);
    } finally {
        isCrawling = false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === "START_CRAWL") {
        startCrawl();
        sendResponse({ status: "ACK" });
        return true;
    } else if (request.command === "GENERATE_PATIENT_JSON" || request.command === "DOWNLOAD_JSON") {
        chrome.storage.local.get([STORAGE_KEYS.CACHED_PATIENT_NOTES], async (result) => {
            const cached = result[STORAGE_KEYS.CACHED_PATIENT_NOTES];
            if (cached) {
                broadcastState("DOWNLOADING", "Downloading Patient JSON...");
                await downloadJSON(cached);
                await clearPreviousSession(true);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                broadcastState("COMPLETE", "Download Complete", "Patient JSON Saved");
            } else {
                startLightweightCrawl();
            }
            sendResponse({ status: "ACK" });
        });
        return true;
    }
});

// Initialization: check if we just loaded a page
logState("READY");
