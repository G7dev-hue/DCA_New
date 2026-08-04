const fs = require('fs');
let code = fs.readFileSync('content_dd_toolkit.js', 'utf8');

const targetStr = `                    setTimeout(resolve, 1500);
                });
            } catch (err) {
                console.warn("Delta Toolkit: Error clicking dummy search button", err);
            }
        }

        setBusy(state, true);`;

const replacementStr = `                    setTimeout(resolve, 1500);
                });
            } catch (err) {
                console.warn("Delta Toolkit: Error clicking dummy search button", err);
            }
            
            if ((!state.procedureHeaders || !state.procedureHeaders.authorization) && 
                (!state.procedureTemplate || !state.procedureTemplate.headers || !state.procedureTemplate.headers.authorization)) {
                throw new Error("Could not automatically refresh session token. Please type a procedure code (e.g. D0120) into the search box and click Search manually, then try again.");
            }
        }

        setBusy(state, true);`;

if (code.includes(targetStr)) {
    code = code.replace(targetStr, replacementStr);
    fs.writeFileSync('content_dd_toolkit.js', code);
    console.log("Safeguard patched!");
} else {
    console.error("Safeguard target not found");
}
