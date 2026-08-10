const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// 1. Update MEMBER_SEARCH_PATH
content = content.replace(
    /const MEMBER_SEARCH_PATH = "\/api\/dot-gateway\/v02\/memberdetail\/search";/,
    'const MEMBER_SEARCH_PATH = "/api/dot-gateway/v1/benefit/memberbenefits/search";'
);

// 2. Add extra endpoints to captureApiTransaction
content = content.replace(
    /        if \(path === MEMBER_SEARCH_PATH\) \{/,
    `        if (path === "/api/dot-gateway/v1/benefit/memberbenefits/routineprocedures/search") {
            state.routineProceduresResponse = responseData;
            persistNonSecretState(state);
            return;
        }
        if (path === "/api/dot-gateway/v1/benefit/client/search") {
            state.clientSearchResponse = responseData;
            persistNonSecretState(state);
            return;
        }
        if (path === MEMBER_SEARCH_PATH) {`
);

// 3. Update payload object in persistNonSecretState
content = content.replace(
    /            const payload = \{\n                memberSearchRequest: sanitizeForOutput\(state\.memberSearchRequest\),\n                memberSearchResponse: sanitizeForOutput\(state\.memberSearchResponse\),\n                procedureTemplate: sanitizeForOutput\(state\.procedureTemplate\)\n            \};/g,
    `            const payload = {
                memberSearchRequest: sanitizeForOutput(state.memberSearchRequest),
                memberSearchResponse: sanitizeForOutput(state.memberSearchResponse),
                routineProceduresResponse: sanitizeForOutput(state.routineProceduresResponse),
                clientSearchResponse: sanitizeForOutput(state.clientSearchResponse),
                procedureTemplate: sanitizeForOutput(state.procedureTemplate)
            };`
);

// 4. Update hydration block
content = content.replace(
    /            state\.memberSearchRequest = saved\.memberSearchRequest \|\| null;\n            state\.memberSearchResponse = saved\.memberSearchResponse \|\| null;\n            state\.procedureTemplate = saved\.procedureTemplate \|\| null;/g,
    `            state.memberSearchRequest = saved.memberSearchRequest || null;
            state.memberSearchResponse = saved.memberSearchResponse || null;
            state.routineProceduresResponse = saved.routineProceduresResponse || null;
            state.clientSearchResponse = saved.clientSearchResponse || null;
            state.procedureTemplate = saved.procedureTemplate || null;`
);

// 5. Update simulated search button click
content = content.replace(
    /                if \(searchBtn\) \{\n                    searchBtn\.click\(\);\n                \} else \{/g,
    `                if (searchBtn) {
                    searchBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                    searchBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                    searchBtn.click();
                } else {`
);

// 6. Rewrite buildCoverageAndMaximums to use the new API directly.
content = content.replace(
    /    function buildCoverageAndMaximums\(subscriber, leaves, dom, provisions\) \{[\s\S]*?        return \{\n            "Yearly Maximum": yearlyMaximum,\n            "Remaining": remaining,\n            "Deductible": deductible,\n            "Used": used\n        \};\n    \}/g,
    `    function buildCoverageAndMaximums(memberResponse, leaves, dom) {
        let ppoBucket = null;
        if (Array.isArray(memberResponse.maximumsAndDeductions)) {
            ppoBucket = memberResponse.maximumsAndDeductions.find(b => (b.networks || []).some(n => String(n).toLowerCase().includes('ppo dentist')));
        }
        const accumulators = ppoBucket ? (ppoBucket.accumulators || []) : [];
        
        let genMaxAmt = "N/A", genMaxRem = "N/A", genMaxUsed = "N/A";
        let genDedAmt = "N/A", genDedRem = "N/A", genDedUsed = "N/A";

        for (const acc of accumulators) {
            if (String(acc.categoryType).toLowerCase() === "general") {
                if (String(acc.accumulatorType).toLowerCase() === "maximum") {
                    genMaxAmt = acc.individualAmount ?? "N/A";
                    genMaxRem = acc.individualAmountRemaining ?? "N/A";
                    genMaxUsed = acc.individualAmountUsed ?? "N/A";
                }
                if (String(acc.accumulatorType).toLowerCase() === "deductible") {
                    genDedAmt = acc.individualAmount ?? "N/A";
                    genDedRem = acc.individualAmountRemaining ?? "N/A";
                    genDedUsed = acc.individualAmountUsed ?? "N/A";
                }
            }
        }
        
        return {
            "Yearly Maximum": genMaxAmt !== "N/A" ? "$" + parseFloat(genMaxAmt).toFixed(2) : "N/A",
            "Remaining": genMaxRem !== "N/A" ? "$" + parseFloat(genMaxRem).toFixed(2) : "N/A",
            "Deductible": genDedAmt !== "N/A" ? "$" + parseFloat(genDedAmt).toFixed(2) : "N/A",
            "Used": genMaxUsed !== "N/A" ? "$" + parseFloat(genMaxUsed).toFixed(2) : "N/A"
        };
    }`
);

// 7. Rewrite buildFinalOutput body entirely to inject new variables cleanly and avoid SyntaxError.
// We will replace everything inside buildFinalOutput.
content = content.replace(
    /    function buildFinalOutput\(state, rawByCode, run\) \{[\s\S]*?return sanitizeForOutput\(output\);\n    \}/g,
    `    function buildFinalOutput(state, rawByCode, run) {
        const memberResponse = state.memberSearchResponse || {};
        const clientRes = state.clientSearchResponse || {};
        const routineRaw = state.routineProceduresResponse || [];
        
        const subscribers = Array.isArray(memberResponse.subscribers) ? memberResponse.subscribers : [];
        const subscriber = subscribers[0] || memberResponse; // Use root memberResponse for new API!
        
        const dom = extractDomContext();
        const leaves = [];
        for (const item of state.supportingApiResponses) {
            leaves.push(...extractLeafValues(item.response || {}));
        }
        const patientName = firstMeaningful([
            state.memberSearchRequest?.patientFirstName ? \`\${state.memberSearchRequest.patientFirstName} \${state.memberSearchRequest.patientLastName || ""}\`.trim() : null,
            subscriber.patientFirstName ? \`\${subscriber.patientFirstName} \${subscriber.patientLastName || ""}\`.trim() : null,
            domValue(dom, ["Patient Name"])
        ]);
        const subscriberName = firstMeaningful([
            state.procedureTemplate?.subscriberFirstName ? \`\${state.procedureTemplate.subscriberFirstName} \${state.procedureTemplate.subscriberLastName || ""}\`.trim() : null,
            subscriber.subscriberFirstName ? \`\${subscriber.subscriberFirstName} \${subscriber.subscriberLastName || ""}\`.trim() : null,
            domValue(dom, ["Subscriber Name"])
        ]);
        const patientDob = firstMeaningful([
            state.memberSearchRequest?.patientDateOfBirth,
            subscriber.patientDateOfBirth,
            domValue(dom, ["Birthdate", "DOB"])
        ]);
        
        const claimInfo = subscriber.claimInformation || {};
        const benefitInfo = subscriber.benefitInformation || {};
        const clientInfo = subscriber.clientInformation || {};
        
        const patientEffective = firstMeaningful([
            subscriber.effectiveDate,
            domValue(dom, ["Effective Date", "Patient Eff Date"])
        ]);
        
        const ppoRoutine = routineRaw.find(r => (r.networks || []).some(n => String(n).toLowerCase().includes('ppo dentist'))) || { routineProcedures: [] };
        
        const procMap = {};
        for (const [code, raw] of Object.entries(rawByCode)) {
            procMap[code] = normalizeProcedure(code, raw, state.procedureResponses.get(code)?.error);
        }
        
        const procedures = Object.values(procMap).filter(p => !p.error);
        const supportText = JSON.stringify(state.supportingApiResponses);
        
        const waitingPeriod = deriveWaitingPeriod(procedures, subscriber.waitExempted, supportText);
        const waitingPeriodAppliesTo = deriveWaitingAppliesTo(procedures);
        const combinedWaitingPeriod = waitingPeriod !== "N/A" ? \`\${waitingPeriod} (\${waitingPeriodAppliesTo})\` : "N/A";
        
        let actualDepAge = "N/A";
        const ageLimits = subscriber.contract?.ageLimitations || {};
        if (ageLimits.childMaxAgeLimit) {
            actualDepAge = \`\${ageLimits.childMaxAgeLimit} (\${ageLimits.childMaxAgeLimitType || ""})\`.trim();
        }
        
        let actualOrthoAgeLimit = "N/A";
        const orthoAgeConfig = Array.isArray(subscriber.orthoAgeLimitConfig) ? subscriber.orthoAgeLimitConfig[0] : null;
        if (orthoAgeConfig) {
            actualOrthoAgeLimit = {
                "Minor Max Age": orthoAgeConfig.minorMaxAge,
                "Student Max Age": orthoAgeConfig.studentMaxAge,
                "Adult/Subscriber Max Age": orthoAgeConfig.subscriberMaxAge,
                "Spouse Max Age": orthoAgeConfig.spouseMaxAge
            };
        }
        
        const provisions = {
            waiting_period: combinedWaitingPeriod,
            waiting_period_applies_to: waitingPeriodAppliesTo,
            dependent_age_limit: actualDepAge,
            ortho_age_limit: actualOrthoAgeLimit
        };

        const output = {
            "Patient/Subscriber Information": {
                "Patient Name": patientName,
                "Date of Birth of the Patient": valueOrNA(patientDob),
                "Member ID": valueOrNA(subscriber.alternateId || subscriber.memberId || state.memberSearchRequest?.memberId),
                "Subscriber Name": subscriberName,
                "Date of Birth of the subscriber": valueOrNA(subscriber.dateOfBirth),
                "SSN": valueOrNA(strictSsnFromText(document.body?.innerText || ""))
            },
            "Insurance Information": {
                "Insurance Name": "Delta Dental",
                "Group Name": valueOrNA(benefitInfo.clientName || clientInfo.clientName),
                "Group Number": valueOrNA(benefitInfo.clientId || clientInfo.clientSpecifiedId),
                "Patient Eff Date": valueOrNA(patientEffective),
                "Payor ID": valueOrNA(claimInfo.payorId)
            },
            "Coverage and Maximums": buildCoverageAndMaximums(memberResponse, leaves, dom),
            "General Benefit Categories": buildRequestedFieldMap(procMap, provisions),
            "Routine Procedures": ppoRoutine.routineProcedures,
            "Plan Provisions": provisions,
            "Extraction Metadata": {
                "Source": "Delta Dental Office Toolkit",
                "Portal": location.hostname,
                "Captured At": new Date().toISOString(),
                "Data Quality": state.memberSearchResponse ? "full_api" : "procedure_api_with_page_fallback"
            }
        };

        return sanitizeForOutput(output);
    }`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
