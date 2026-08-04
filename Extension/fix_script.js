const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// 1. Term Date Active
content = content.replace(
    /        const patientTermDate = firstMeaningful\(\[\n            patient.isSubscriber \? subscriber.terminationDate : patient.record\?.terminationDate,\n            patient.isSubscriber \? subscriber.eligibilityEndDate : patient.record\?.eligibilityEndDate,\n            domValue\(dom, \["Patient Term Date", "Termination Date", "Coverage End Date"\]\)\n        \]\);/g,
    `        let patientTermDate = firstMeaningful([
            patient.isSubscriber ? subscriber.terminationDate : patient.record?.terminationDate,
            patient.isSubscriber ? subscriber.eligibilityEndDate : patient.record?.eligibilityEndDate,
            domValue(dom, ["Patient Term Date", "Termination Date", "Coverage End Date"])
        ]);
        if (String(patientStatus || "").toLowerCase() === "active") {
            patientTermDate = "";
        }`
);

// 2. Remove fields from Insurance Information
content = content.replace(
    /                "Group Number": valueOrNA\(groupNumber\),\n                "Fee Schedule": valueOrNA\(feeSchedule\),\n                "Insurance Address": valueOrNA\(insuranceAddress\),\n                "Insurance Phone": valueOrNA\(insurancePhone\),\n                "Provider Network Status": valueOrNA\(providerNetworkStatus\),/g,
    `                "Group Number": valueOrNA(groupNumber),`
);

// 3. Restore heuristic logic for Waiting Period, Payment frequency, and add Dependent age limit + Ortho age limit formatted.
content = content.replace(
    /\/\/ DCA requested that we do NOT invent answers.*?\n.*?\n.*?\n.*?\n.*?\n.*?\n.*?\n.*?\n.*?\n.*?\n        const provisions = \{[^}]*\};/s,
    `        const waitingPeriod = deriveWaitingPeriod(procedures, subscriber.waitExempted, supportText);
        const waitingPeriodAppliesTo = deriveWaitingAppliesTo(procedures);
        const combinedWaitingPeriod = waitingPeriod !== "N/A" ? \`\${waitingPeriod} (\${waitingPeriodAppliesTo})\` : "N/A";
        
        let actualOrthoAgeLimit = "N/A";
        if (benefitInfo.orthoAgeLimitConfig && benefitInfo.orthoAgeLimitConfig.length > 0) {
            const cfg = benefitInfo.orthoAgeLimitConfig[0];
            actualOrthoAgeLimit = \`Student: \${cfg.studentMaxAge || "N/A"}, Minor: \${cfg.minorMaxAge || "N/A"}, Spouse: \${cfg.spouseMaxAge || "N/A"}, IRS: \${cfg.irsMaxAge || "N/A"}\`;
        }

        let actualDepAge = "N/A";
        if (benefitInfo.ageLimitations) {
            actualDepAge = \`Child: \${benefitInfo.ageLimitations.childMaxAgeLimit || "N/A"}, Student: \${benefitInfo.ageLimitations.studentMaxAgeLimit || "N/A"}\`;
        }

        const provisions = {
            waiting_period: combinedWaitingPeriod,
            dependent_age_limit: actualDepAge,
            ortho_payment_frequency: orthoPaymentFrequency(procMap),
            ortho_age_limit: actualOrthoAgeLimit
        };`
);

// 4. Change Coverage and Maximums to output raw maximumsAndDeductions and filter procedure networks
content = content.replace(
    /            "Eligibility Notes": eligibilityNotes.length \? eligibilityNotes : \["N\/A"\],\n            "Coverage and Maximums": \{\n[^\}]*\n            \},\n            "General Benefit Categories": buildRequestedFieldMap\(procMap, provisions\),/s,
    `            "Eligibility Notes": eligibilityNotes,
            "Coverage and Maximums": subscriber.maximumsAndDeductions || [],
            "General Benefit Categories": buildRequestedFieldMap(procMap, provisions),`
);

// 5. Change collectEligibilityNotes
content = content.replace(
    /    function collectEligibilityNotes\(supporting, procedures\) \{\n        const notes = \[\];\n        for \(const item of supporting\) \{\n            const leaves = flattenLeaves\(\[item.response\]\);\n            for \(const leaf of leaves\) \{\n                if \(typeof leaf.value !== "string"\) continue;\n                if \(\/eligib\|note\|remark\|message\|restriction\|exclusion\|limitation\|warning\/i.test\(leaf.normalizedPath\)\) \{\n                    const value = cleanText\(leaf.value\);\n                    if \(value.length > 2 && value.length < 1200\) notes.push\(value\);\n                \}\n            \}\n        \}\n        for \(const proc of procedures\) notes.push\(\.\.\.toArray\(proc.exclusions_and_limitations\)\);\n        return uniqueStrings\(notes\).slice\(0, 150\);\n    \}/s,
    `    function collectEligibilityNotes(supporting, procedures) {
        const structuredNotes = {};
        for (const item of supporting) {
            const res = item.response;
            if (res.messages) structuredNotes["Global Messages"] = res.messages;
            if (res.subscribers && res.subscribers[0]) {
                const sub = res.subscribers[0];
                if (sub.claimBenefitInfo && sub.claimBenefitInfo.messages) {
                    structuredNotes["Benefit Messages"] = sub.claimBenefitInfo.messages;
                }
            }
        }
        structuredNotes["Procedure Limitations"] = {};
        for (const proc of procedures) {
            if (proc.exclusions_and_limitations && proc.exclusions_and_limitations.length > 0) {
                structuredNotes["Procedure Limitations"][proc.procedure_code] = proc.exclusions_and_limitations;
            }
        }
        return structuredNotes;
    }`
);

// 6. Network filter in normalizeProcedure
content = content.replace(
    /                number_of_quads: "N\/A",\n                networks: raw.networks \|\| \[\],\n                error: error \|\| "No API response returned."/g,
    `                number_of_quads: "N/A",
                networks: (raw.networks || []).filter(n => (n.name || "").toLowerCase().includes("ppo")),
                error: error || "No API response returned."`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
