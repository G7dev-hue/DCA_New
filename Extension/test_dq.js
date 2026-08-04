const fs = require('fs');
const extractorModule = require('./content_dentaquest.js');

const har = JSON.parse(fs.readFileSync('providers.dentaquest.com_Archive [26-08-04 11-08-05].har', 'utf8'));

// Extract API responses from HAR
const apiData = {};
for (const entry of har.log.entries) {
  const url = entry.request.url;
  const key = extractorModule.classifyEndpoint(url);
  if (key && entry.response.content && entry.response.content.text) {
    try {
      apiData[key] = JSON.parse(entry.response.content.text);
    } catch(e) {}
  }
}

const result = extractorModule.buildExtraction(apiData, {}, {});
console.log(JSON.stringify(result, null, 2));
