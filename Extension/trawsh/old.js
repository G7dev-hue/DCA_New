window.__content_aetna_loaded = true;
console.log("[Aetna] content script loaded on: " + window.location.href);

const clean = (s) => (s || "").trim().replace(/\s+/g, ' ');

// ══════════════════════════════════════════════════════════════════════════
// GUARD
// ══════════════════════════════════════════════════════════════════════════

function isBenefitsPage() {
    return document.body?.innerText?.includes("Service Level Benefits");
}

// ══════════════════════════════════════════════════════════════════════════
// PATIENT / PAYER / DATES
// ══════════════════════════════════════════════════════════════════════════

function getMultiTabValues(labelText) {
    var rows = document.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll("td");
        for (var j = 0; j < cells.length; j++) {
            var text = cells[j].innerText;
            if (text.includes(labelText)) {
                var parts = text.split("\t");
                var labels = parts[0].split("\n").map(function(s) { return s.trim(); });
                var values = parts[1] ? parts[1].split("\n").map(function(s) { return s.trim(); }) : [];
                var result = {};
                labels.forEach(function(l, idx) {
                    if (l) result[l.replace(":", "").toLowerCase().replace(/ /g, "_")] = values[idx] || "N/A";
                });
                return result;
            }
        }
    }
    return {};
}

// ══════════════════════════════════════════════════════════════════════════
// MAXIMUMS / DEDUCTIBLES — legend-anchored extraction
// ══════════════════════════════════════════════════════════════════════════
// Aetna renders each Maximums/Deductibles block as:
//   <div class="well well-white wraper wraper-mini">
//     <legend class="legend">Maximums - In Network</legend>
//     <div><table>...rows...</table></div>
//   </div>
// Plans may show 1 or 2 Maximums tables (In Network / Out of Network split)
// plus a Deductibles table, in any order. Header-counting to tell them apart
// breaks the moment a plan has more than one Maximums table (2 headers before
// the Deductibles table's header instead of 1), so we anchor on the legend
// text directly instead — robust to however many tables exist or what order
// they appear in.
//
// Per policy: only IN-NETWORK maximums are used for patient notes. Out of
// Network maximums are read (and can be inspected) but intentionally
// excluded from the returned maximums array.

function _rowsFromLegend(legendEl) {
    var container = legendEl.parentElement;
    var table = container ? container.querySelector("table") : null;
    if (!table) return [];
    var rows = table.querySelectorAll("tr");
    var out = [];
    rows.forEach(function(r) {
        var cells = r.querySelectorAll("td");
        if (cells.length >= 4) {
            var t = clean(cells[0].innerText);
            if (t && !t.match(/^D\d{4}/)) {
                out.push({
                    type:      t,
                    coverage:  clean(cells[1].innerText),
                    amount:    clean(cells[2].innerText),
                    remaining: clean(cells[3].innerText),
                    message:   clean(cells[4] ? cells[4].innerText : "")
                });
            }
        }
    });
    return out;
}

function scrapeMaximumsAndDeductibles() {
    var legends = document.querySelectorAll("legend");
    var maxInNetwork  = [];
    var maxOutNetwork = [];
    var deductibles   = [];

    legends.forEach(function(lg) {
        var text = clean(lg.textContent);
        var isMaximums   = /maximums/i.test(text);
        var isDeductible = /deductibles/i.test(text);
        // "in and out of network" is checked FIRST and explicitly, because
        // "out of network" is a plain substring of it — checking the
        // out-of-network-only pattern first would wrongly swallow this
        // combined-table case (as it did for a plan using this exact
        // legend wording, which zeroed out In-Network maximums entirely).
        var isCombined  = /in\s+and\s+out\s+of\s+network/i.test(text);
        var isOutOnly   = !isCombined && /out\s*of\s*network/i.test(text);
        var isInOnly    = !isCombined && !isOutOnly && /in\s*network/i.test(text);

        if (isMaximums && (isCombined || isInOnly)) {
            // Combined table applies to both networks; the same row is the
            // correct In-Network figure, so it goes into maxInNetwork.
            maxInNetwork = maxInNetwork.concat(_rowsFromLegend(lg));
        }
        if (isMaximums && (isCombined || isOutOnly)) {
            maxOutNetwork = maxOutNetwork.concat(_rowsFromLegend(lg));
        }
        if (isDeductible) {
            deductibles = deductibles.concat(_rowsFromLegend(lg));
        }
    });

    return {
        maximums: maxInNetwork,               // In-Network only — used for patient notes
        maximums_out_of_network: maxOutNetwork, // kept for reference/debugging, not used downstream
        deductibles: deductibles
    };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN TABLE SCRAPER
// Single pass through all rows, categorizing by section
// (Maximums/Deductibles handled separately above — this loop now just
// SKIPS those header/data rows instead of trying to classify them, so they
// can't leak into co_insurance/remarks or get misfiled.)
// ══════════════════════════════════════════════════════════════════════════

function scrapeTables() {
    var allRows = document.querySelectorAll("tr");
    var remarks = [];
    var coRows  = [];
    var svcRows = [];

    var section = "none";

    for (var i = 0; i < allRows.length; i++) {
        var text = allRows[i].innerText.trim();
        var cols = allRows[i].querySelectorAll("td");

        // ── Section headers ──────────────────────────────────────────────

        // 4-column service level table (the real one with percentages)
        if (text.includes("Procedure Code") &&
            text.includes("Percentage") &&
            text.includes("Frequency") &&
            text.includes("Message")) {
            section = "svc";
            continue;
        }

        // Stop service section at "PAYMENT IS BASED"
        if (section === "svc" && text.includes("PAYMENT IS BASED")) {
            section = "done";
            continue;
        }

        // Co-insurance header
        if (text.includes("Type") && text.includes("Pat%") && !text.includes("Procedure")) {
            section = "co";
            continue;
        }

        // Maximums/Deductibles header — already extracted via legend anchors
        // above, so just skip past these rows (don't classify/collect them
        // here, and don't fall through to remarks/co-insurance either).
        if (text.includes("Type") && text.includes("Coverage") && text.includes("Amount") &&
            text.includes("Remaining") && text.includes("Message") && !text.includes("Procedure")) {
            section = "skip_max_ded";
            continue;
        }
        if (section === "skip_max_ded") {
            // stay skipped until we hit the next recognized header (svc/co)
            // or a blank row signaling the table ended — either way, just
            // don't collect this row into anything.
            if (cols.length >= 4 || text === "") continue;
        }

        // Plan remarks — simple text rows before maximums
        if (section === "none" && cols.length <= 1 && text.length > 3 &&
            !text.includes("Patient") && !text.includes("Payer") &&
            !text.includes("Dates") && !text.includes("Plan Begin") &&
            !text.includes("Information Type") && !text.includes("Related Entity") &&
            !text.includes("Name:") && !text.includes("Address:") &&
            !text.includes("Type") && text !== "Plan Level Remarks") {
            remarks.push(text);
            continue;
        }

        // ── Data rows ────────────────────────────────────────────────────

        if (section === "co" && cols.length >= 2) {
            var ct = clean(cols[0].innerText);
            if (ct && !ct.includes("Type")) {
                coRows.push({
                    type:       ct,
                    percentage: clean(cols[1].innerText)
                });
            }
        }

        if (section === "svc" && cols.length >= 2) {
            var code = clean(cols[0].innerText);
            if (!code) continue;
            var freqText = cols[2] ? cols[2].innerText : "";
            var col3Text = cols[3] ? cols[3].innerText : "";
            var sharesMatch = col3Text.match(/Shares frequency with\s*([^\n]+)/i);
            svcRows.push({
                procedure_code:         code,
                percentage_copay:       clean(cols[1].innerText),
                frequency:              (freqText.match(/Frequency:\s*([^\n]+)/) || [])[1] || "N/A",
                history:                (freqText.match(/History:\s*([^\n]+)/)   || [])[1] || "N/A",
                age_limit:              (freqText.match(/Age Limitation:\s*([^\n]+)/) || [])[1] || "N/A",
                shares_frequency_with:  sharesMatch ? clean(sharesMatch[1]) : "",
                message:                clean(col3Text)
            });
        }
    }

    return { remarks, coRows, svcRows };
}

// ══════════════════════════════════════════════════════════════════════════
// BUILD FULL PAYLOAD
// ══════════════════════════════════════════════════════════════════════════

function buildAetnaPayload() {
    var t   = scrapeTables();
    var md  = scrapeMaximumsAndDeductibles();
    return {
        source:    "ClaimConnect - Extended Plan Benefits",
        timestamp: new Date().toISOString(),
        patient:   getMultiTabValues("Member ID or SSN:"),
        payer:     getMultiTabValues("Coverage:"),
        dates:     getMultiTabValues("Plan Begin:"),
        plan_level_remarks:      t.remarks,
        maximums:                md.maximums,               // In-Network only
        maximums_out_of_network: md.maximums_out_of_network, // reference only, not used in patient notes
        deductibles:             md.deductibles,
        co_insurance:            t.coRows,
        service_level_benefits:  t.svcRows
    };
}

// ══════════════════════════════════════════════════════════════════════════
// DOWNLOAD
// ══════════════════════════════════════════════════════════════════════════

function downloadAetnaJSON(data) {
    var patientName = (data.patient && data.patient.name
        ? data.patient.name : "patient")
        .replace(/[^a-z0-9]/gi, "_").toLowerCase();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = patientName + "_aetna_benefits.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════════
// INIT — expose scrape+download function for popup to trigger
// ══════════════════════════════════════════════════════════════════════════

window.__aetnaDownload = function() {
    const data = buildAetnaPayload();
    downloadAetnaJSON(data);
};