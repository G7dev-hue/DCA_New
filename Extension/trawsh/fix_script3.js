const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// 1. Coverage and Maximums structure (structured our way but exact API data)
content = content.replace(
    /            "Eligibility Notes": eligibilityNotes,\n            "Coverage and Maximums": subscriber.maximumsAndDeductions \|\| \[\],\n            "Plan Provisions": \{\n                "Waiting Period": provisions.waiting_period,\n                "Dependent Age Limit": provisions.dependent_age_limit\n            \},\n            "General Benefit Categories": buildRequestedFieldMap\(procMap, provisions\),/g,
    `            "Coverage and Maximums": buildCoverageAndMaximums(subscriber, leaves, dom),
            "General Benefit Categories": buildRequestedFieldMap(procMap, provisions),`
);

// 2. Add buildCoverageAndMaximums function
content = content.replace(
    /    function buildFinalOutput\(state, rawByCode, run\) \{/g,
    `    function buildCoverageAndMaximums(subscriber, leaves, dom) {
        let maxDed = [];
        if (Array.isArray(subscriber.maximumsAndDeductions)) maxDed = subscriber.maximumsAndDeductions;
        else if (subscriber.maximumsAndDeductions && Array.isArray(subscriber.maximumsAndDeductions.accumulators)) maxDed = [subscriber.maximumsAndDeductions];
        
        const accumulators = maxDed.flatMap(m => m.accumulators || []);
        const getAccum = (type, category) => accumulators.find(a => a.accumulatorType === type && a.categoryType === category) || {};
        
        const annualMaxObj = getAccum("Maximum", "General");
        const indDedObj = getAccum("Deductible", "General");
        const orthoDedObj = getAccum("Deductible", "Orthodontic");
        const orthoMaxObj = getAccum("Maximum", "Orthodontic");

        return {
            "Yearly Maximum": moneyValue(annualMaxObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] }, "total") ?? domValue(dom, ["Yearly Maximum", "Annual Maximum"])),
            "Remaining": moneyValue(annualMaxObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["annual", "yearly"], ["maximum", "max"]], exclude: ["ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Yearly Maximum Remaining", "Annual Maximum Remaining"])),
            "Individual Deductible Paid to Date": moneyValue(indDedObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] }, "used") ?? domValue(dom, ["Individual Deductible Paid to Date", "Individual Deductible Used"])),
            "Individual Deductible Remaining": moneyValue(indDedObj.individualAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["individual", "member"], ["deductible", "ded"]], exclude: ["family", "ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Individual Deductible Remaining"])),
            "Family Deductible Paid to Date": moneyValue(indDedObj.familyAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] }, "used") ?? domValue(dom, ["Family Deductible Paid to Date", "Family Deductible Used"])),
            "Family Deductible Remaining": moneyValue(indDedObj.familyAmountRemaining ?? pickFinancialLeaf(leaves, { scope: [["family"], ["deductible", "ded"]], exclude: ["ortho", "orthodont"] }, "remaining") ?? domValue(dom, ["Family Deductible Remaining"])),
            "Orthodontic Deductible": moneyValue(orthoDedObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] }, "total") ?? domValue(dom, ["Orthodontic Deductible", "Ortho Deductible"])),
            "Orthodontic Deductible Paid to Date": moneyValue(orthoDedObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["deductible", "ded"]], exclude: [] }, "used") ?? domValue(dom, ["Orthodontic Deductible Paid to Date", "Ortho Deductible Paid to Date"])),
            "Orthodontic Maximum": moneyValue(orthoMaxObj.individualAmount ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "total") ?? domValue(dom, ["Orthodontic Maximum", "Ortho Maximum", "Ortho Lifetime Maximum"])),
            "Orthodontic Maximum Paid to Date": moneyValue(orthoMaxObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "used") ?? domValue(dom, ["Orthodontic Maximum Paid to Date", "Ortho Maximum Paid to Date"]))
        };
    }

    function buildFinalOutput(state, rawByCode, run) {`
);

// 3. Add back waiting_period and dependent_age_limit to Coverage and Maximums object? The user asked to remove eligibility notes. Let's append provisions to the output of Coverage and Maximums so it is structured their way.
content = content.replace(
    /    function buildCoverageAndMaximums\(subscriber, leaves, dom\) \{/g,
    `    function buildCoverageAndMaximums(subscriber, leaves, dom, provisions) {`
);

content = content.replace(
    /            "Coverage and Maximums": buildCoverageAndMaximums\(subscriber, leaves, dom\),/g,
    `            "Coverage and Maximums": buildCoverageAndMaximums(subscriber, leaves, dom, provisions),`
);

content = content.replace(
    /            "Orthodontic Maximum Paid to Date": moneyValue\(orthoMaxObj.individualAmountUsed \?\? pickFinancialLeaf\(leaves, \{ scope: \[\["ortho", "orthodont"\], \["maximum", "max", "lifetime"\]\], exclude: \["deductible"\] \}, "used"\) \?\? domValue\(dom, \["Orthodontic Maximum Paid to Date", "Ortho Maximum Paid to Date"\]\)\)\n        \};\n    \}/g,
    `            "Orthodontic Maximum Paid to Date": moneyValue(orthoMaxObj.individualAmountUsed ?? pickFinancialLeaf(leaves, { scope: [["ortho", "orthodont"], ["maximum", "max", "lifetime"]], exclude: ["deductible"] }, "used") ?? domValue(dom, ["Orthodontic Maximum Paid to Date", "Ortho Maximum Paid to Date"])),
            "Waiting Period": provisions.waiting_period,
            "Dependent Age Limit": provisions.dependent_age_limit
        };
    }`
);

// 4. In buildFinalOutput, uncomment the provisions
content = content.replace(
    /\/\/ DCA requested that we do NOT invent answers.*?\/\*\n        const deductiblePreventive.*?\*\//s,
    `// Heuristics re-enabled for requested fields
        const waitingPeriod = deriveWaitingPeriod(procedures, subscriber.waitExempted, supportText);
        const waitingPeriodAppliesTo = deriveWaitingAppliesTo(procedures);
        const combinedWaitingPeriod = waitingPeriod !== "N/A" ? \`\${waitingPeriod} (\${waitingPeriodAppliesTo})\` : "N/A";
        
        const deductiblePreventive = deriveDeductibleApplicability(procedures.filter(item => ["preventative"].includes(item.category)), leaves, "prevent");
        const deductibleDiagnostic = deriveDeductibleApplicability(procedures.filter(item => ["exams", "diagnostic"].includes(item.category)), leaves, "diagnostic");`
);

content = content.replace(
    /        const provisions = \{\n            waiting_period: combinedWaitingPeriod,\n            dependent_age_limit: actualDepAge,\n            ortho_payment_frequency: orthoPaymentFrequency\(procMap\),\n            ortho_age_limit: actualOrthoAgeLimit\n        \};/s,
    `        const provisions = {
            deductible_applies_to_preventive: "N/A", // user disabled
            deductible_applies_to_diagnostic: "N/A", // user disabled
            waiting_period: combinedWaitingPeriod,
            waiting_period_applies_to: waitingPeriodAppliesTo,
            major_services_paid_on_prep_or_seat: "N/A", // disabled
            missing_tooth_clause: "N/A", // disabled
            dependent_age_limit: actualDepAge,
            d0120_d0150_share_frequency_with_d0140: "N/A", // disabled
            permanent_unrestored_molars_only: "N/A", // disabled
            posterior_composites_downgraded_to_amalgam: "N/A", // disabled
            porcelain_crowns_downgraded_on_posterior_teeth: "N/A", // disabled
            d2950_same_day_as_crown: "N/A", // disabled
            d4341_number_of_quads: "N/A", // disabled
            d4910_d1110_share_frequency: "N/A", // disabled
            ortho_payment_frequency: orthoPaymentFrequency(procMap),
            ortho_age_limit: actualOrthoAgeLimit
        };`
);


// 5. Filter networks to PPO Dentist only
content = content.replace(
    /        const networkRecords = raw.map\(bucket => normalizeNetworkBucket\(code, bucket\)\).filter\(Boolean\);/g,
    `        const networkRecords = raw.map(bucket => normalizeNetworkBucket(code, bucket)).filter(Boolean).filter(n => (n.network || "").toLowerCase().includes("ppo dentist"));`
);


fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
