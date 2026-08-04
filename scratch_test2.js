const fs = require('fs');
const text = fs.readFileSync('/home/sai/ispace/DCA_New/new_dd_tool', 'utf8');
const data = JSON.parse(text);

for (const entry of data.log.entries) {
    if (entry.response && entry.response.content && entry.response.content.text) {
        if (entry.request.url.includes("api/dot-gateway/v1/benefit/memberbenefits/procedures/search?type=codes")) continue;
        if (entry.request.url.includes("api/dot-gateway")) {
            try {
                const j = JSON.parse(entry.response.content.text);
                if (j.subscribers && j.subscribers[0]) {
                    console.log(JSON.stringify(j.subscribers[0], null, 2).substring(0, 1500));
                }
            } catch (e) {}
        }
    }
}
