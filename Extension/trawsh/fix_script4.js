const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// Update MEMBER_SEARCH_PATH
content = content.replace(
    /const MEMBER_SEARCH_PATH = "\/api\/dot-gateway\/v02\/memberdetail\/search";/,
    'const MEMBER_SEARCH_PATH = "/api/dot-gateway/v1/benefit/memberbenefits/search";'
);

// Capture routine procedures and client info
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

// Update hydration and persistence to include new keys
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

content = content.replace(
    /            state\.memberSearchRequest = saved\.memberSearchRequest \|\| null;\n            state\.memberSearchResponse = saved\.memberSearchResponse \|\| null;\n            state\.procedureTemplate = saved\.procedureTemplate \|\| null;/g,
    `            state.memberSearchRequest = saved.memberSearchRequest || null;
            state.memberSearchResponse = saved.memberSearchResponse || null;
            state.routineProceduresResponse = saved.routineProceduresResponse || null;
            state.clientSearchResponse = saved.clientSearchResponse || null;
            state.procedureTemplate = saved.procedureTemplate || null;`
);

// Adjust the dummy search trigger so it works better
content = content.replace(
    /                if \(searchBtn\) \{\n                    searchBtn\.click\(\);\n                \} else \{/g,
    `                if (searchBtn) {
                    searchBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                    searchBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                    searchBtn.click();
                } else {`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
