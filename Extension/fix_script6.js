const fs = require('fs');
let content = fs.readFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', 'utf8');

// Filter maxDed for PPO Dentist
content = content.replace(
    /        const accumulators = maxDed\.flatMap\(m => m\.accumulators \|\| \[\]\);/g,
    `        const ppoMaxDed = maxDed.filter(m => (m.networks || []).some(n => n.toLowerCase().includes('ppo dentist')));
        const accumulators = ppoMaxDed.flatMap(m => m.accumulators || []);`
);

fs.writeFileSync('/home/sai/ispace/DCA_New/Extension/content_dd_toolkit.js', content);
