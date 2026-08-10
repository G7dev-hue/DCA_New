// content_delta_dental.js - V2.0 (Complete Delta Dental Benefits Auditor)

const clean = (s) => (s || "").trim().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// CDT codes to search for - split into batches of 10. Additional Batch 6 is added for new plan PDF.
const BATCH_1 = ["D0120", "D0180", "D0140", "D0150", "D0274", "D0210", "D0330", "D0220", "D0230", "D0240"];
const BATCH_2 = ["D1110", "D1120", "D1206", "D1351", "D1510", "D2140", "D2331", "D2620", "D2740", "D2950"];
const BATCH_3 = ["D3310", "D3330", "D3347", "D4260", "D4341", "D4355", "D4381", "D4910", "D5110", "D7953"];
const BATCH_4 = ["D5740", "D6010", "D6056", "D6065", "D6194", "D6245", "D7140", "D7240", "D7210", "D6750"];
const BATCH_5 = ["D7259", "D8010", "D8080", "D8090", "D9110", "D9222", "D9230", "D9243", "D9310", "D4346"];
const BATCH_6 = ["D9944", "D0364", "D0431", "D2391", "D2962", "D4249"];
console.log("Delta Dental scraper V2.0 initialized - Ready to audit benefits");

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Extract all static fields from patient card
// ══════════════════════════════════════════════════════════════════════════

function extractStaticFields(cardElement) {
    /**
     * Extract all pt-staticfield label/value pairs from a patient card
     */
    const fields = {};
    const staticFieldElements = cardElement.querySelectorAll('.pt-staticfield');
    
    staticFieldElements.forEach(el => {
        const label = el.querySelector('.pt-staticfield-label')?.innerText || "";
        const value = el.querySelector('.pt-staticfield-text')?.innerText || "";
        if (label && value) {
            fields[clean(label)] = clean(value);
        }
    });
    
    return fields;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Scrape member / eligibility information
// ══════════════════════════════════════════════════════════════════════════

function scrapeEligibilityInfo() {
    // Collect all pt-staticfield label→value pairs from the entire visible page
    const raw = {};
    document.querySelectorAll('.pt-staticfield').forEach(el => {
        const label = clean(el.querySelector('.pt-staticfield-label')?.innerText || "");
        const value = clean(el.querySelector('.pt-staticfield-text')?.innerText || "");
        if (label) raw[label] = value || "N/A";
    });

    // Alias map: output key → list of possible label strings (case-insensitive)
    const aliases = {
        member_id:              ["Member ID", "Member Number", "Member #", "Subscriber ID"],
        relation_to_subscriber: ["Relation to Subscriber", "Relationship", "Relationship to Subscriber"],
        subscriber_name:        ["Subscriber Name", "Subscriber"],
        patient_dob:            ["Date of Birth", "Patient Date of Birth", "DOB", "Patient DOB"],
        subscriber_dob:         ["Subscriber Date of Birth", "Subscriber DOB"],
        ssn:                    ["SSN", "Social Security Number", "Social Security #"],
        group_name:             ["Group Name", "Employer", "Employer Name"],
        group_number:           ["Group Number", "Group #", "Group ID", "Group No"],
        effective_date:         ["Patient Effective Date", "Effective Date", "Coverage Begin Date", "Coverage Effective Date"],
        termination_date:       ["Patient Termination Date", "Termination Date", "Coverage End Date", "Coverage Termination Date"],
        network_status:         ["Provider Network Status", "Network Status", "Network", "Provider Status"],
    };

    const eligibility = {};
    for (const [key, labels] of Object.entries(aliases)) {
        for (const label of labels) {
            const found = Object.keys(raw).find(k => k.toLowerCase() === label.toLowerCase());
            if (found) { eligibility[key] = raw[found]; break; }
        }
        // Try data-testid fallbacks if still not found
        if (!eligibility[key]) {
            const testIds = [
                key.replace(/_/g, ''),            // memberId
                key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), // memberDob
            ];
            for (const tid of testIds) {
                const el = document.querySelector(`[data-testid="${tid}"], [data-testid="${tid}Field"]`);
                if (el) { eligibility[key] = clean(el.innerText) || "N/A"; break; }
            }
        }
        if (!eligibility[key]) eligibility[key] = "N/A";
    }

    // Preserve all raw fields so nothing is silently dropped
    eligibility.all_fields = raw;
    return eligibility;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 1: PATIENT CARD SCRAPER
// ══════════════════════════════════════════════════════════════════════════

function scrapePatientCard(cardElement) {
    /**
     * Scrape a single patient card: name, plan, group, and all static fields
     */
    if (!cardElement) return null;
    
    const header = cardElement.querySelector('.patient-card-header');
    const body = cardElement.querySelector('.patient-card-body');
    
    // Extract name (MuiTypography-h3)
    const nameEl = header?.querySelector('.MuiTypography-h3');
    const name = nameEl ? clean(nameEl.innerText) : "N/A";
    
    // Extract plan (body2 under d-flex)
    const planEl = header?.querySelector('.d-flex .MuiTypography-body2');
    const plan = planEl ? clean(planEl.innerText).replace(/^Plan:\s*/i, '') : "N/A";
    
    // Extract group (body2 after d-flex)
    const groupEl = Array.from(header?.querySelectorAll('.MuiTypography-body2') || []).find(el => 
        clean(el.innerText).toLowerCase().includes('group:')
    );
    const group = groupEl ? clean(groupEl.innerText).replace(/^Group:\s*/i, '') : "N/A";
    
    // Extract all static fields
    const staticFields = extractStaticFields(body);
    
    return {
        name,
        plan,
        group,
        static_fields: staticFields
    };
}

function scrapeAllPatientCards() {
    /**
     * Scrape all patient cards on the page
     */
    const patientCards = [];
    const cardElements = document.querySelectorAll('[data-testid^="patientCard_"]');
    
    cardElements.forEach(el => {
        const card = scrapePatientCard(el);
        if (card) patientCards.push(card);
    });
    
    return patientCards;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 3: OVERVIEW TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

function scrapeOverviewTab() {
    /**
     * Scrape benefits overview, maximums, deductibles, package history, claims address
     */
    const overview = {};
    
    // ── Benefits Overview Table ──
    const benefitsTable = document.querySelector('[data-testid="benefitsOverviewTable"]');
    if (benefitsTable) {
        const rows = benefitsTable.querySelectorAll('tbody tr');
        const benefitsOverview = [];
        
        rows.forEach((row, index) => {
            // Skip header row (row with network names in cells instead of treatment type)
            if (index === 0 && row.innerText.includes("Delta Dental PPO Dentist")) {
                return; // Skip this header row
            }
            
            const thCell = row.querySelector('th');
            const tdCells = row.querySelectorAll('td');
            
            if (thCell && tdCells.length >= 3) {
                benefitsOverview.push({
                    treatment_type: clean(thCell.innerText) || "N/A",
                    contract_benefit_level: clean(tdCells[0]?.innerText) || "N/A",
                    delta_dental_premier: clean(tdCells[1]?.innerText) || "N/A",
                    non_delta_dental: clean(tdCells[2]?.innerText) || "N/A"
                });
            }
        });
        overview.benefits_overview = benefitsOverview;
    }
    
    // ── Maximums Table ──
    const maximumsTable = document.querySelector('[data-testid="maximumsTable"]');
    if (maximumsTable) {
        const rows = maximumsTable.querySelectorAll('tbody tr');
        const maximums = [];
        
        rows.forEach((row, index) => {
            // Skip header row - contains "Type", "Treatment type", "Network", "Amount"
            if (index === 0 && row.innerText.includes("Treatment type") && row.innerText.includes("Amount")) {
                return;
            }
            
            const thCell = row.querySelector('th');
            const tdCells = row.querySelectorAll('td');
            
            if (thCell && tdCells.length >= 5) {
                // Extract type info from th
                const typeText = clean(thCell.innerText) || "N/A";
                
                // Extract treatment types from second cell (divs with links or text)
                const treatmentTypesDiv = tdCells[0];
                const treatmentTypes = [];
                if (treatmentTypesDiv) {
                    treatmentTypesDiv.querySelectorAll('a, p').forEach(el => {
                        const text = clean(el.innerText);
                        if (text && !treatmentTypes.includes(text)) {
                            treatmentTypes.push(text);
                        }
                    });
                }
                
                // Extract networks from third cell
                const networksDiv = tdCells[1];
                const networks = [];
                if (networksDiv) {
                    networksDiv.querySelectorAll('div').forEach(el => {
                        const text = clean(el.innerText);
                        if (text && !networks.includes(text)) {
                            networks.push(text);
                        }
                    });
                }
                
                maximums.push({
                    type: typeText,
                    treatment_types: treatmentTypes,
                    networks: networks,
                    amount: clean(tdCells[2]?.innerText) || "N/A",
                    used: clean(tdCells[3]?.innerText) || "N/A",
                    remaining: clean(tdCells[4]?.innerText) || "N/A"
                });
            }
        });
        overview.maximums = maximums;
    }
    
    // ── Deductibles Table ──
    const deductiblesTable = document.querySelector('[data-testid="deductiblesTable"]');
    if (deductiblesTable) {
        const rows = deductiblesTable.querySelectorAll('tbody tr');
        const deductibles = [];
        
        rows.forEach((row, index) => {
            // Skip header row - contains "Type", "Treatment type", "Network", "Amount"
            if (index === 0 && row.innerText.includes("Treatment type") && row.innerText.includes("Amount")) {
                return;
            }
            
            const thCell = row.querySelector('th');
            const tdCells = row.querySelectorAll('td');
            
            if (thCell && tdCells.length >= 5) {
                const typeText = clean(thCell.innerText) || "N/A";
                
                const treatmentTypesDiv = tdCells[0];
                const treatmentTypes = [];
                if (treatmentTypesDiv) {
                    treatmentTypesDiv.querySelectorAll('a, p').forEach(el => {
                        const text = clean(el.innerText);
                        if (text && !treatmentTypes.includes(text)) {
                            treatmentTypes.push(text);
                        }
                    });
                }
                
                const networksDiv = tdCells[1];
                const networks = [];
                if (networksDiv) {
                    networksDiv.querySelectorAll('div').forEach(el => {
                        const text = clean(el.innerText);
                        if (text && !networks.includes(text)) {
                            networks.push(text);
                        }
                    });
                }
                
                deductibles.push({
                    type: typeText,
                    treatment_types: treatmentTypes,
                    networks: networks,
                    amount: clean(tdCells[2]?.innerText) || "N/A",
                    used: clean(tdCells[3]?.innerText) || "N/A",
                    remaining: clean(tdCells[4]?.innerText) || "N/A"
                });
            }
        });
        overview.deductibles = deductibles;
    }
    
    // ── Benefit Package History Table ──
    const historyTable = document.querySelector('[data-testid="benefitPackageHistoryTable"]');
    if (historyTable) {
        const rows = historyTable.querySelectorAll('tbody tr');
        const history = [];
        
        rows.forEach((row, index) => {
            // Skip header row if present
            if (index === 0 && (row.innerText.includes("Effective") || row.innerText.includes("Benefit Package"))) {
                return;
            }
            
            const thCell = row.querySelector('th');
            const tdCells = row.querySelectorAll('td');
            
            if (thCell && tdCells.length >= 2) {
                history.push({
                    effective_date: clean(thCell.innerText) || "N/A",
                    end_date: clean(tdCells[0]?.innerText) || "N/A",
                    benefit_package: clean(tdCells[1]?.innerText) || "N/A"
                });
            }
        });
        overview.benefit_package_history = history;
    }
    
    // ── Claims Mailing Address ──
    const claimsAddress = document.querySelector('[data-testid="claimsMailingAddress"]');
    if (claimsAddress) {
        const addressLines = [];
        claimsAddress.querySelectorAll('p').forEach(p => {
            const text = clean(p.innerText);
            if (text) addressLines.push(text);
        });
        overview.claims_mailing_address = addressLines;
    }

    // ── Deductible Applicability (Preventive / Diagnostic) ──
    // Scan the full page text for these flags; they appear near the deductibles section
    const pageText = document.body.innerText || "";
    const deductibleApplicability = {};

    // Pattern: "Deductible Applies to Preventive: Yes/No" or adjacent labeled elements
    const deductibleEls = document.querySelectorAll('.pt-staticfield, [data-testid*="deductible"]');
    deductibleEls.forEach(el => {
        const label = clean(el.querySelector('.pt-staticfield-label')?.innerText || el.innerText || "").toLowerCase();
        const value = clean(el.querySelector('.pt-staticfield-text')?.innerText || "");
        if (label.includes("deductible") && label.includes("preventive")) {
            deductibleApplicability.applies_to_preventive = value || "N/A";
        }
        if (label.includes("deductible") && label.includes("diagnostic")) {
            deductibleApplicability.applies_to_diagnostic = value || "N/A";
        }
    });

    // Regex fallback on raw page text
    if (!deductibleApplicability.applies_to_preventive) {
        const m = pageText.match(/deductible\s+applies?\s+to\s+preventive[:\s]+(\w+)/i);
        deductibleApplicability.applies_to_preventive = m ? m[1] : "N/A";
    }
    if (!deductibleApplicability.applies_to_diagnostic) {
        const m = pageText.match(/deductible\s+applies?\s+to\s+diagnostic[:\s]+(\w+)/i);
        deductibleApplicability.applies_to_diagnostic = m ? m[1] : "N/A";
    }
    overview.deductible_applicability = deductibleApplicability;

    return overview;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 4: PLAN PROVISIONS TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

function scrapePlanProvisionsTab() {
    /**
     * Scrape plan provisions table (provision name + description)
     */
    const provisionsTable = document.querySelector('[data-testid="planProvisionsTable"]');
    if (!provisionsTable) return [];
    
    const rows = provisionsTable.querySelectorAll('tbody tr');
    const provisions = [];
    
    rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
            provisions.push({
                provision_name: clean(cells[0]?.innerText) || "N/A",
                description: clean(cells[1]?.innerText) || "N/A"
            });
        }
    });
    
    return provisions;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 5: WAITING PERIODS TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

function scrapeWaitingPeriodsTab() {
    const table =
        document.querySelector('[data-testid="waitingPeriodsTable"]') ||
        Array.from(document.querySelectorAll("table")).find(t =>
            /Waiting period begins/i.test(t.innerText) &&
            /Waiting period ends/i.test(t.innerText)
        );

    if (!table) {
        return {
            rows: [],
            note: "Waiting periods table not found"
        };
    }

    const results = [];

    table.querySelectorAll("tbody tr").forEach(row => {
        const headerCell = row.querySelector("th");
        const cells = row.querySelectorAll("td");

        if (!headerCell || cells.length < 2) return;

        const treatmentGroups = [];

        let current = null;

        Array.from(headerCell.children).forEach(el => {
            const text = clean(el.innerText);
            if (!text) return;

            if (/^D\d{4}/i.test(text)) {
                if (current) {
                    current.procedure_codes = text;
                }
            } else {
                current = {
                    treatment_type: text,
                    procedure_codes: ""
                };
                treatmentGroups.push(current);
            }
        });

        // Fallback if there are no child elements
        if (treatmentGroups.length === 0) {
            const lines = headerCell.innerText
                .split("\n")
                .map(clean)
                .filter(Boolean);

            for (let i = 0; i < lines.length; i++) {
                if (/^D\d{4}/i.test(lines[i])) continue;

                treatmentGroups.push({
                    treatment_type: lines[i],
                    procedure_codes:
                        i + 1 < lines.length &&
                        /^D\d{4}/i.test(lines[i + 1])
                            ? lines[++i]
                            : ""
                });
            }
        }

        results.push({
            treatments_and_procedures: treatmentGroups,
            waiting_period_begins: clean(cells[0].innerText),
            waiting_period_ends: clean(cells[1].innerText)
        });
    });

    return {
        rows: results
    };
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 5b: TREATMENT HISTORY TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

const TREATMENT_HISTORY_HEADER_MAP = {
    "description": "description",
    "limitation": "limitation",
    "limitation may also apply to": "limitation_may_also_apply_to",
    "service date": "service_date",
    "tooth code": "tooth_code",
    "tooth description": "tooth_description",
    "tooth surface": "tooth_surface"
};

function isTreatmentHistoryTable(table) {
    const headerText = clean(
        Array.from(table.querySelectorAll('thead th, thead td'))
            .map(c => c.innerText)
            .join(' ')
    ).toLowerCase();
    return headerText.includes('description') &&
        headerText.includes('limitation') &&
        headerText.includes('service date');
}

function findTreatmentHistoryTables() {
    return Array.from(document.querySelectorAll('table')).filter(isTreatmentHistoryTable);
}

function findTreatmentHistoryCard(table) {
    let card = table;
    let parent = card.parentElement;
    while (parent) {
        const qualifyingInParent = Array.from(parent.querySelectorAll('table')).filter(isTreatmentHistoryTable);
        if (qualifyingInParent.length > 1) break;
        card = parent;
        parent = parent.parentElement;
    }
    return card;
}

function extractCardCode(card, table) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if (table.contains(node)) continue;
        const match = clean(node.textContent).match(/\b(D\d{3,4})\b/);
        if (match) return match[1];
    }
    const fallback = clean(card.innerText).match(/\b(D\d{3,4})\b/);
    return fallback ? fallback[1] : "N/A";
}

async function waitForTreatmentHistoryTables(maxWaitMs = 8000) {
    let lastCount = -1;
    let stableTicks = 0;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        const count = findTreatmentHistoryTables().length;
        if (count > 0 && count === lastCount) {
            stableTicks++;
            if (stableTicks >= 2) break;
        } else {
            stableTicks = 0;
        }
        lastCount = count;
        await sleep(400);
    }

    return findTreatmentHistoryTables();
}

async function scrapeTreatmentHistoryTab() {
    const tables = await waitForTreatmentHistoryTables();

    if (tables.length === 0) {
        return { procedures: [], note: "No treatment history cards found" };
    }

    const procedures = [];
    const seenCodes = new Set();

    tables.forEach(table => {
        const card = findTreatmentHistoryCard(table);
        const code = extractCardCode(card, table);

        if (seenCodes.has(code)) return;
        seenCodes.add(code);

        const { headers, rows } = parseTreatmentHistoryTable(table);
        procedures.push({ code, headers, rows });
    });

    return { procedures };
}

function parseTreatmentHistoryTable(table) {
    let headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    let bodyRows = Array.from(table.querySelectorAll('tbody tr'));

    if (headerCells.length === 0 && bodyRows.length) {
        const firstRowCells = Array.from(bodyRows[0].querySelectorAll('th, td'));
        const looksLikeHeader = firstRowCells.some(cell =>
            /description|limitation|service date|tooth/i.test(clean(cell.innerText))
        );
        if (looksLikeHeader) {
            headerCells = firstRowCells;
            bodyRows = bodyRows.slice(1);
        }
    }

    const headers = headerCells.map(cell => clean(cell.innerText));

    // rowspan/colspan-aware grid — a physical <tr> can be missing cells that a
    // previous row's rowspan is still covering, so positional cells.forEach()
    // silently shifts everything left. Expand into a virtual grid instead.
    const grid = [];
    bodyRows.forEach((row, rowIndex) => {
        if (!grid[rowIndex]) grid[rowIndex] = [];
        let colIndex = 0;
        Array.from(row.querySelectorAll('th, td')).forEach(cell => {
            while (grid[rowIndex][colIndex] !== undefined) colIndex++;
            const text = clean(cell.innerText);
            const rowSpan = cell.rowSpan || 1;
            const colSpan = cell.colSpan || 1;
            for (let r = 0; r < rowSpan; r++) {
                if (!grid[rowIndex + r]) grid[rowIndex + r] = [];
                for (let c = 0; c < colSpan; c++) {
                    grid[rowIndex + r][colIndex + c] = text;
                }
            }
            colIndex += colSpan;
        });
    });

    const rows = grid.map(cellValues => {
        const entry = {};
        cellValues.forEach((value, index) => {
            const rawHeader = headers[index] ? clean(headers[index]).toLowerCase() : "";
            const key = TREATMENT_HISTORY_HEADER_MAP[rawHeader] ||
                rawHeader.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') ||
                `col_${index}`;
            entry[key] = value || "N/A";
        });
        return entry;
    }).filter(row => Object.keys(row).length);

    return { headers, rows };
}
// ══════════════════════════════════════════════════════════════════════════
// STEP 6: BENEFITS SEARCH TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

async function searchBenefitCodes(codes) {
    const searchInput = document.querySelector('[data-testid="autocompleteSearchInput"]');
    const searchButton = document.querySelector('[data-testid="autocompleteSearchButton"]');

    if (!searchInput || !searchButton) {
        console.warn("Cannot find search input or button");
        return [];
    }

// Activate the input first
searchInput.focus();
searchInput.click();
await sleep(500);

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

setter.call(searchInput, "");
searchInput.dispatchEvent(new Event("input", { bubbles: true }));
searchInput.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(800);

const codeString = codes.join(",");
console.log(`Searching batch: ${codeString}`);

setter.call(searchInput, codeString);
searchInput.dispatchEvent(new Event("input", { bubbles: true }));
searchInput.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(800);

// Guard: if React stomped the value, retry once
if (searchInput.value !== codeString) {
    setter.call(searchInput, codeString);
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(500);
}

searchButton.click();

    // Wait for all results to render (~500ms per code + 2s base)
    await sleep(2000 + codes.length * 500);

    const container = document.querySelector('.search-results-root');
    if (!container) return [];

    return parseMultipleBenefitResults(container);
}

function parseMultipleBenefitResults(container) {
    const resultsByCode = new Map();

    const addResult = (parsed) => {
        if (!parsed) return;

        if (resultsByCode.has(parsed.code)) {
            const existing = resultsByCode.get(parsed.code);

            // Merge rows for duplicate codes
            existing.rows.push(...parsed.rows);

            // Keep the first valid benefit level if current is N/A
            if (
                existing.benefit_level === "N/A" &&
                parsed.benefit_level !== "N/A"
            ) {
                existing.benefit_level = parsed.benefit_level;
            }

            // Prefer "Does not apply" if any table reports it
            if (parsed.deductible === "Does not apply") {
                existing.deductible = "Does not apply";
            }
        } else {
            resultsByCode.set(parsed.code, parsed);
        }
    };

    // ───────────────────────────────────────────────────────────
    // Strategy 1: each direct child is one result card
    // ───────────────────────────────────────────────────────────
    const directChildren = Array.from(container.children)
        .filter(el => /\bD\d{3,4}\b/.test(el.innerText));

    if (directChildren.length > 0) {
        directChildren.forEach(card => {
            const match = (card.innerText || "").match(/\b(D\d{3,4})\b/);
            if (!match) return;

            const code = match[1];

            card.querySelectorAll("table").forEach(table => {
                const parsed = parseTableContent(table, code, card);
                addResult(parsed);
            });
        });

        if (resultsByCode.size > 0) {
            return Array.from(resultsByCode.values());
        }
    }

    // ───────────────────────────────────────────────────────────
    // Strategy 2: find cards from tables
    // ───────────────────────────────────────────────────────────
    const seen = new Set();

    container.querySelectorAll("table").forEach(table => {
        let card = table;

        while (card.parentElement && card.parentElement !== container) {
            card = card.parentElement;
        }

        if (seen.has(card)) return;
        seen.add(card);

        const match = (card.innerText || "").match(/\b(D\d{3,4})\b/);
        if (!match) return;

        const code = match[1];

        card.querySelectorAll("table").forEach(t => {
            const parsed = parseTableContent(t, code, card);
            addResult(parsed);
        });
    });

    return Array.from(resultsByCode.values());
}

function parseTableContent(table, code, cardEl) {
    // cardEl is the isolated card element for this code — use it for metadata
    const contextText = (cardEl || table).innerText || "";

    const pctMatch = contextText.match(/(\d+)%/);
    const benefit_level = pctMatch ? pctMatch[1] + "%" : "N/A";

    const deductible = contextText.includes("Amount does not apply to deductible")
        ? "Does not apply"
        : "Applies";

    const headers = [];
    table.querySelectorAll("thead th, thead td").forEach(th => {
        headers.push(clean(th.innerText).toLowerCase());
    });

    // Handle "Comments" tables (invalid procedure codes)
    if (headers.length === 1 && headers[0] === "comments") {
        const comment = clean(table.querySelector("tbody")?.innerText || "");
        return {
            code,
            benefit_level,
            deductible,
            rows: [{
                description: comment || "None",
                limitation: "None",
                service_date: "None",
                age_limits: "None",
                pre_approval: "None"
            }]
        };
    }

    const rows = [];

    table.querySelectorAll("tbody tr").forEach(row => {
        const th = row.querySelector("th");
        const cells = row.querySelectorAll("td");

        if (!th && cells.length === 0) return;

        const description = th ? clean(th.innerText) : "None";

        const get = (i) =>
            cells[i] ? clean(cells[i].innerText) || "None" : "None";

        rows.push({
            description,
            limitation: get(0),
            service_date: get(1),
            age_limits: get(2),
            pre_approval: get(3)
        });
    });

    if (rows.length === 0) return null;

    return {
        code,
        benefit_level,
        deductible,
        rows
    };
}
async function scrapeBenefitsSearchTab() {
    const batches = [BATCH_1, BATCH_2, BATCH_3, BATCH_4, BATCH_5, BATCH_6];
    const allResults = [];

    for (let i = 0; i < batches.length; i++) {
        console.log(`Benefits search batch ${i + 1}/${batches.length}...`);
        const batchResults = await searchBenefitCodes(batches[i]);
        allResults.push(...batchResults);
        if (i < batches.length - 1) await sleep(1500);
    }

    console.log(`Benefits search complete: ${allResults.length} codes scraped`);
    return allResults;
}

function triggerDeltaDentalDownload(auditData) {
    const sanitize = (s) => (s || "").trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
    const patient = sanitize(
        auditData.primary_patient?.name ||
        auditData.eligibility?.subscriber_name ||
        auditData.eligibility?.member_id ||
        "patient"
    ) || "patient";
    const filename = `${patient}_Delta_Dental.json`;

    const blob = new Blob([JSON.stringify(auditData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
    console.log(`✓ Downloaded: ${filename}`);
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2: TAB NAVIGATION
// ══════════════════════════════════════════════════════════════════════════

async function clickTab(dataTestId) {
    /**
     * Click a tab and wait for content to load
     */
    const tab = document.querySelector(`[data-testid="${dataTestId}"]`);
    if (tab) {
        tab.click();
        await sleep(1000); // Wait 1 second after click
        console.log(`Clicked tab: ${dataTestId}`);
        return true;
    }
    console.warn(`Could not find tab: ${dataTestId}`);
    return false;
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 7: FAMILY MEMBERS TAB SCRAPER
// ══════════════════════════════════════════════════════════════════════════

function scrapeFamilyMembersTab() {
    /**
     * Scrape all family member patient cards
     */
    return scrapeAllPatientCards();
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN CRAWLER - ORCHESTRATE ALL STEPS
// ══════════════════════════════════════════════════════════════════════════

async function runDeltaDentalCrawl() {
    if (!chrome.runtime?.id) return;

    console.log("=== DELTA DENTAL COMPLETE AUDIT STARTED ===");

    try {
        const auditData = {
            source: "Delta Dental",
            timestamp: new Date().toISOString(),
            primary_patient: scrapeAllPatientCards()[0] || null,
            tabs: {}
        };

        // OVERVIEW TAB
        console.log("Scraping Overview tab...");
        await clickTab("overviewTab");
        auditData.tabs.overview = scrapeOverviewTab();

        // Eligibility info is scraped from static fields visible on the overview tab
        console.log("Scraping eligibility/member info...");
        auditData.eligibility = scrapeEligibilityInfo();

        // PLAN PROVISIONS TAB
        console.log("Scraping Plan Provisions tab...");
        await clickTab("planProvisionsTab");
        auditData.tabs.plan_provisions = scrapePlanProvisionsTab();

        // WAITING PERIODS TAB
        console.log("Scraping Waiting Periods tab...");
        await clickTab("waitingPeriodsTab");
        auditData.tabs.waiting_periods = scrapeWaitingPeriodsTab();

        // BENEFITS SEARCH TAB
        console.log("Scraping Benefits Search tab...");
    await clickTab("benefitsSearchTab");
// Wait until search UI is ready
    let input = null;
    let button = null;

    const start = Date.now();

    while (Date.now() - start < 10000) {
    input = document.querySelector('[data-testid="autocompleteSearchInput"]');
    button = document.querySelector('[data-testid="autocompleteSearchButton"]');

    if (
        input &&
        button &&
        !input.disabled &&
        input.offsetParent !== null
    ) {
        break;
    }

    await sleep(250);
}
// Small buffer for React rendering
await sleep(1500);
auditData.tabs.benefits_search = await scrapeBenefitsSearchTab();
        // TREATMENT HISTORY TAB
        console.log("Scraping Treatment History tab...");
        const historyTabClicked = await clickTab("treatmentHistoryTab");
        if (historyTabClicked) {
            auditData.tabs.treatment_history = await scrapeTreatmentHistoryTab();
        } else {
            console.warn("Treatment History tab not found — skipping");
            auditData.tabs.treatment_history = { rows: [], note: "Tab not found" };
        }

        // FAMILY MEMBERS TAB
        console.log("Scraping Family Members tab...");
        await clickTab("familyMembersTab");
        auditData.tabs.family_members = scrapeFamilyMembersTab();

        console.log("=== AUDIT COMPLETE ===");
        console.log("Full audit data:", auditData);

        // Store in Chrome storage
        chrome.storage.local.get("audit_context", (result) => {
            let context = result.audit_context || {};
            context.delta_dental_data = auditData;
            chrome.storage.local.set({ "audit_context": context }, () => {
                console.log("✓ Delta Dental complete audit data stored successfully");
                triggerDeltaDentalDownload(auditData);
            });
        });

    } catch (error) {
        console.error("❌ Delta Dental crawl error:", error);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === "START_CRAWL") {
        console.log("Received START_CRAWL command for Delta Dental");
        runDeltaDentalCrawl().then(() => {
            sendResponse({ status: "Delta Dental complete audit finished" });
        });
        return true;
    }
});
