const fs = require('fs');
const text = fs.readFileSync('/home/sai/ispace/DCA_New/new_dd_tool', 'utf8');
const data = JSON.parse(text);

for (const entry of data.log.entries) {
    if (entry.response && entry.response.content && entry.response.content.text) {
        if (entry.request.url.includes("api/dot-gateway")) {
            try {
                const j = JSON.parse(entry.response.content.text);
                if (j.subscribers && j.subscribers[0]) {
                    const sub = j.subscribers[0];
                    console.log("orthoAgeLimitConfig:", JSON.stringify(sub.orthoAgeLimitConfig, null, 2));
                    console.log("studentAgeLimit:", sub.studentAgeLimit);
                    console.log("dependentAgeLimit:", sub.dependentAgeLimit);
                    console.log("ageLimit:", sub.ageLimit);
                }
            } catch (e) {}
        }
    }
}
