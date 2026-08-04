const fs = require('fs');
const content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

const updated = content.replace(
    /const annualMax = buildFinancialRecord\(leaves, dom, "annual_max"\);\s*const indDed = buildFinancialRecord\(leaves, dom, "individual_deductible"\);\s*const famDed = buildFinancialRecord\(leaves, dom, "family_deductible"\);\s*const orthoDed = buildFinancialRecord\(leaves, dom, "ortho_deductible"\);\s*const orthoMax = buildFinancialRecord\(leaves, dom, "ortho_maximum"\);/,
    `let maxDed = [];
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
        };`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', updated);
