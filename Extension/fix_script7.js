const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// Inject the parsing logic before `const output = {`
content = content.replace(
    /        const output = \{/g,
    `        const routineRaw = state.routineProceduresResponse || [];
        const ppoRoutine = routineRaw.find(r => (r.networks || []).some(n => String(n).toLowerCase().includes('ppo dentist'))) || { routineProcedures: [] };
        
        let actualDepAge = provisions?.dependent_age_limit || "N/A";
        let actualOrthoAgeLimit = provisions?.ortho_age_limit || "N/A";
        
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
            actualDepAge = \`\${ageLimits.childMaxAgeLimit} (\${ageLimits.childMaxAgeLimitType || ""})\`.trim();
        }

        const output = {`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
