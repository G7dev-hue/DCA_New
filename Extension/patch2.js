const fs = require('fs');
let code = fs.readFileSync('content_dd_toolkit.js', 'utf8');

// 1. Remove floating UI invocation
code = code.replace(
    /installFloatingUiWhenReady\(state, nativeFetch\);/,
    '// installFloatingUiWhenReady removed to avoid conflicting separate popup'
);

// 2. Strip Authorization header before persisting
code = code.replace(
    /procedureTemplate: sanitizeForOutput\(state\.procedureTemplate\)/,
    `procedureTemplate: (function() {
                    const cloned = sanitizeForOutput(state.procedureTemplate);
                    if (cloned && cloned.headers) {
                        delete cloned.headers.authorization;
                        delete cloned.headers.Authorization;
                    }
                    return cloned;
                })()`
);

// 3. Add dummy button click logic in startCrawl
code = code.replace(
    /        if \(!state\.procedureTemplate\) \{\n            throw new Error\("No authenticated procedure request has been captured\. Perform one ordinary procedure-code lookup in the Toolkit, then run the extractor again\."\);\n        \}/,
    `        if (!state.procedureTemplate) {
            throw new Error("No authenticated procedure request has been captured. Perform one ordinary procedure-code lookup in the Toolkit, then run the extractor again.");
        }

        if (!state.procedureHeaders || !state.procedureHeaders.authorization || !state.procedureTemplate.headers || !state.procedureTemplate.headers.authorization) {
            setStatus(state, "Refreshing API session token automatically...", "working");
            try {
                await new Promise(resolve => {
                    const searchBtn = Array.from(document.querySelectorAll("button")).find(b => (b.textContent || "").trim() === "Search");
                    if (searchBtn) {
                        searchBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                        searchBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                        searchBtn.click();
                    } else {
                        console.warn("Delta Toolkit: Could not find Search button to refresh token.");
                    }
                    setTimeout(resolve, 1500);
                });
            } catch (err) {
                console.warn("Delta Toolkit: Error clicking dummy search button", err);
            }
        }`
);

// 4. Add missing field for member search response
code = code.replace(
    /        \]\.filter\(Boolean\);/,
    `        ].filter(Boolean);

        if (Object.keys(memberRoot).length === 0) {
            missingFields.push("MEMBER_SEARCH_RESPONSE_WAS_EMPTY_OR_NOT_CAPTURED");
        }`
);

fs.writeFileSync('content_dd_toolkit.js', code);
console.log("patch2 applied!");
