const fs = require('fs');
let code = fs.readFileSync('popup.js', 'utf8');

const targetStr = `                if (isDeltaToolkit) {
                    status.innerText = "Crawl started... Please wait.";`;

const replacementStr = `                if (isDeltaToolkit) {
                    if (response && response.status && response.status.includes("[!]")) {
                        status.innerText = response.status;
                        return;
                    }
                    status.innerText = "Crawl started... Please wait.";`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replacementStr);
    fs.writeFileSync('popup.js', code);
    console.log("popup.js patched!");
} else {
    console.error("Target string not found in popup.js");
}
