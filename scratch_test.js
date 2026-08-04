const fs = require('fs');
const text = fs.readFileSync('/home/sai/ispace/DCA_New/new_dd_tool', 'utf8');
const data = JSON.parse(text);

for (const entry of data.log.entries) {
    if (entry.response && entry.response.content && entry.response.content.text) {
        if (entry.request.url.includes("api/dot-gateway/v1/benefit/memberbenefits/procedures/search?type=codes")) continue;
        if (entry.request.url.includes("api/dot-gateway")) {
            try {
                const j = JSON.parse(entry.response.content.text);
                if (j.subscribers && j.subscribers[0] && j.subscribers[0].maximumsAndDeductions) {
                    console.log(JSON.stringify(j.subscribers[0].maximumsAndDeductions, null, 2));
                } else if (j.maximumsAndDeductions) {
                    console.log(JSON.stringify(j.maximumsAndDeductions, null, 2));
                } else if (Array.isArray(j) && j[0] && j[0].maximumsAndDeductions) {
                    console.log(JSON.stringify(j[0].maximumsAndDeductions, null, 2));
                }
            } catch (e) {}
        }
    }
}
