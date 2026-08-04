const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

content = content.replace(
    /        const subscriber = subscribers\[0\] \|\| \{\};/g,
    `        const subscriber = state.memberSearchResponse || {};`
);

content = content.replace(
    /    function buildCoverageAndMaximums\(subscriber, leaves, dom, provisions\) \{/g,
    `    function buildCoverageAndMaximums(subscriber, leaves, dom) {`
);

content = content.replace(
    /            "Coverage and Maximums": buildCoverageAndMaximums\(subscriber, leaves, dom, provisions\),/g,
    `            "Coverage and Maximums": buildCoverageAndMaximums(subscriber, leaves, dom),`
);

// We need to output the provisions separately or under "Plan Provisions".
// The user previously said: "waiting period and applies to are to be combined and dependent age limit not parsed properly"
// And in the client API response, there is `contractLanguage.specialInstructions` etc. Let's add Routine Procedures and Provisions!

content = content.replace(
    /        const subscriberName = joinName\(subscriber\.subscriberFirstName, subscriber\.subscriberLastName\);/g,
    `        const subscriberName = joinName(subscriber.subscriberFirstName || state.procedureTemplate?.subscriberFirstName, subscriber.subscriberLastName || state.procedureTemplate?.subscriberLastName);`
);

content = content.replace(
    /        return \{\n            "Extraction Metadata":/g,
    `        // Parse routine procedures
        const routineRaw = state.routineProceduresResponse || [];
        const ppoRoutine = routineRaw.find(r => (r.networks || []).some(n => n.toLowerCase().includes('ppo dentist'))) || { routineProcedures: [] };
        
        // Parse client config for provisions if available
        const clientRes = state.clientSearchResponse || {};
        let actualDepAge = provisions.dependent_age_limit;
        let actualOrthoAgeLimit = provisions.ortho_age_limit;
        
        const orthoAgeConfig = Array.isArray(subscriber.orthoAgeLimitConfig) ? subscriber.orthoAgeLimitConfig[0] : null;
        if (orthoAgeConfig) {
            actualOrthoAgeLimit = {
                "Minor Max Age": orthoAgeConfig.minorMaxAge,
                "Student Max Age": orthoAgeConfig.studentMaxAge,
                "Adult/Subscriber Max Age": orthoAgeConfig.subscriberMaxAge,
                "Spouse Max Age": orthoAgeConfig.spouseMaxAge
            };
        }
        
        const ageLimits = subscriber.contract?.ageLimitations || {};
        if (ageLimits.childMaxAgeLimit) {
            actualDepAge = \`\${ageLimits.childMaxAgeLimit} (\${ageLimits.childMaxAgeLimitType})\`;
        }

        const networkBenefits = Array.isArray(subscriber.networkBenefits) ? subscriber.networkBenefits : [];
        const ppoBenefits = networkBenefits.find(b => (b.networks || []).some(n => n.toLowerCase().includes('ppo dentist'))) || { coverages: [] };
        
        // Build new final object with structured API results
        return {
            "Extraction Metadata":`
);

content = content.replace(
    /            "Eligibility Notes": \{\n                "Global Messages": globalMessages,\n                "Benefit Messages": benefitMessages,\n                "Procedure Limitations": procedureLimitations\n            \},\n/g,
    `` // The user asked to remove "eligibility notes" since it was a mess, but they might want "Plan Provisions" populated cleanly.
);

content = content.replace(
    /            "General Benefit Categories": buildRequestedFieldMap\(procMap, provisions\),/g,
    `            "General Benefit Categories": buildRequestedFieldMap(procMap, provisions),
            "Routine Procedures": ppoRoutine.routineProcedures,
            "Plan Provisions": {
                "Waiting Period": combinedWaitingPeriod,
                "Dependent Age Limit": actualDepAge,
                "Ortho Age Limits": actualOrthoAgeLimit
            },`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
