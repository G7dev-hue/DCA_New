const fs = require('fs');
let code = fs.readFileSync('content_dd_toolkit.js', 'utf8');

const targetStr = `        if (!state.procedureTemplate) {
            throw new Error("No authenticated procedure request has been captured. Perform one ordinary procedure-code lookup in the Toolkit, then run the extractor again.");
        }

        setBusy(state, true);`;

// Handle CRLF or LF seamlessly
const flexibleTargetStr = targetStr.replace(/\r?\n/g, '\n');
const lines = code.split(/\r?\n/);
let found = false;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('throw new Error("No authenticated procedure request has been captured.')) {
        lines.splice(i + 2, 0, `
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
        }`);
        found = true;
        break;
    }
}

if (!found) {
    console.error("Could not find startCrawl logic");
    process.exit(1);
}

fs.writeFileSync('content_dd_toolkit.js', lines.join('\n'));
console.log("patch3 applied successfully");
