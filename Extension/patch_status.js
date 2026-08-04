const fs = require('fs');

// Patch content_dd_toolkit.js
let contentCode = fs.readFileSync('content_dd_toolkit.js', 'utf8');

// 1. In MAIN world, setStatus needs to send STATUS messages
const setStatusTarget = `    function setStatus(state, message, type = "working") {
        if (!state.statusEl) return;
        state.statusEl.textContent = message;
        state.statusEl.style.color = type === "error" ? "#dc2626" : type === "ready" ? "#16a34a" : "#475569";
    }`;
const setStatusReplacement = `    function setStatus(state, message, type = "working") {
        try {
            postPageMessage("STATUS", { status: message, type });
        } catch (e) {}
        
        if (!state.statusEl) return;
        state.statusEl.textContent = message;
        state.statusEl.style.color = type === "error" ? "#dc2626" : type === "ready" ? "#16a34a" : "#475569";
    }`;

if (contentCode.includes(setStatusTarget)) {
    contentCode = contentCode.replace(setStatusTarget, setStatusReplacement);
} else {
    console.warn("Could not find setStatus target");
}

// 2. In ISOLATED world, listen for STATUS messages and forward them
const isolatedBridgeTarget = `            if (message.type === "ERROR") {`;
const isolatedBridgeReplacement = `            if (message.type === "STATUS") {
                try {
                    chrome.runtime.sendMessage({ command: "STATUS_UPDATE", status: message.status });
                } catch (e) {}
            }

            if (message.type === "ERROR") {`;

if (contentCode.includes(isolatedBridgeTarget)) {
    contentCode = contentCode.replace(isolatedBridgeTarget, isolatedBridgeReplacement);
} else {
    console.warn("Could not find isolatedBridge target");
}

fs.writeFileSync('content_dd_toolkit.js', contentCode);

// Patch popup.js
let popupCode = fs.readFileSync('popup.js', 'utf8');

// 1. Add Delta Toolkit detection
popupCode = popupCode.replace(
    /const isDeltaMA = url\.includes\('deltadentalma\.com\/'\);/,
    `const isDeltaMA = url.includes('deltadentalma.com/');
    const isDeltaToolkit = url.includes('dentalofficetoolkit.com');`
);

popupCode = popupCode.replace(
    /    \} else if \(isDeltaMA\) \{\n        status.innerText = "DD_MA: Ready";\n    \}/,
    `    } else if (isDeltaMA) {
        status.innerText = "DD_MA: Ready";
    } else if (isDeltaToolkit) {
        status.innerText = "Delta Toolkit: Ready to extract";
    }`
);

// 2. Prevent window.close() for Delta Toolkit and add listener
const btnCrawlTarget = `        // ── All other sites (existing behaviour) ────────────────────────
        chrome.tabs.sendMessage(tab.id, { command: "START_CRAWL" }, (response) => {
            if (chrome.runtime.lastError) {
                status.innerText = "Error: Refresh page and try again.";
                console.warn("Crawl message error:", chrome.runtime.lastError.message);
            } else {
                status.innerText = "Crawl started...";
                window.close();
            }
        });`;

const btnCrawlReplacement = `        // ── All other sites (existing behaviour) ────────────────────────
        chrome.tabs.sendMessage(tab.id, { command: "START_CRAWL" }, (response) => {
            if (chrome.runtime.lastError) {
                status.innerText = "Error: Refresh page and try again.";
                console.warn("Crawl message error:", chrome.runtime.lastError.message);
            } else {
                if (isDeltaToolkit) {
                    status.innerText = "Crawl started... Please wait.";
                    // Listen for progress updates
                    chrome.runtime.onMessage.addListener((msg) => {
                        if (msg.command === "STATUS_UPDATE") {
                            status.innerText = msg.status;
                        }
                    });
                } else {
                    status.innerText = "Crawl started...";
                    window.close();
                }
            }
        });`;

if (popupCode.includes(btnCrawlTarget)) {
    popupCode = popupCode.replace(btnCrawlTarget, btnCrawlReplacement);
} else {
    console.warn("Could not find btnCrawl target in popup.js");
}

fs.writeFileSync('popup.js', popupCode);
console.log("patch_status applied!");
