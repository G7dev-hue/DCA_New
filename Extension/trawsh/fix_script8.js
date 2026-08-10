const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

const injectedBlock = `        const routineRaw = state.routineProceduresResponse || [];
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
            actualDepAge = \\\`\\\${ageLimits.childMaxAgeLimit} (\\\${ageLimits.childMaxAgeLimitType || ""})\\\`.trim();
        }

        const output = {`;

// Replace all occurrences back to `const output = {`
content = content.replace(new RegExp(injectedBlock.replace(/[.*+?^$\{key\}()|[\\]\\\\]/g, '\\\\$&'), 'g'), '        const output = {');

// Now carefully inject the variables at the VERY TOP of buildFinalOutput so they don't clash
content = content.replace(
    /    function buildFinalOutput\\(state, rawByCode, run\\) \\{/,
    `    function buildFinalOutput(state, rawByCode, run) {
        const routineRaw = state.routineProceduresResponse || [];
        const ppoRoutine = routineRaw.find(r => (r.networks || []).some(n => String(n).toLowerCase().includes('ppo dentist'))) || { routineProcedures: [] };
        const clientRes = state.clientSearchResponse || {};`
);

// We need to fix actualDepAge and actualOrthoAgeLimit. They were already defined in content_dd_toolkit.js.
// Let's modify the place where they are defined.
content = content.replace(
    /        let actualDepAge = "N\/A";/g,
    `        let actualDepAge = provisions?.dependent_age_limit || "N/A";
        const ageLimits = subscriber.contract?.ageLimitations || {};
        if (ageLimits.childMaxAgeLimit) {
            actualDepAge = \`\${ageLimits.childMaxAgeLimit} (\${ageLimits.childMaxAgeLimitType || ""})\`.trim();
        }`
);

content = content.replace(
    /        let actualOrthoAgeLimit = "N\/A";/g,
    `        let actualOrthoAgeLimit = provisions?.ortho_age_limit || "N/A";
        const orthoAgeConfig = Array.isArray(subscriber.orthoAgeLimitConfig) ? subscriber.orthoAgeLimitConfig[0] : null;
        if (orthoAgeConfig) {
            actualOrthoAgeLimit = {
                "Minor Max Age": orthoAgeConfig.minorMaxAge,
                "Student Max Age": orthoAgeConfig.studentMaxAge,
                "Adult/Subscriber Max Age": orthoAgeConfig.subscriberMaxAge,
                "Spouse Max Age": orthoAgeConfig.spouseMaxAge
            };
        }`
);

// Wait, actualDepAge and actualOrthoAgeLimit were originally modified in the heuristic block:
// "if (benefitInfo.ageLimitations) { actualDepAge = ... }"
// But we just replaced their definitions. The old heuristic blocks might still be there and overwrite our good values!
// Let's remove the heuristic blocks.
content = content.replace(
    /        if \(benefitInfo\.ageLimitations\) \{[\\s\\S]*?\}/g,
    `        // (removed heuristic age block)`
);
content = content.replace(
    /        if \(cfg\) \{[\\s\\S]*?\}/g,
    `        // (removed heuristic ortho block)`
);

// We need to also clean up any leftover \`let actualDepAge = provisions.dependent_age_limit;\` that fix_script5 added near the return statement
content = content.replace(
    /        \/\/ Parse routine procedures[\\s\\S]*?let actualOrthoAgeLimit = provisions\.ortho_age_limit;/g,
    `        // Cleared duplicate definitions`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
