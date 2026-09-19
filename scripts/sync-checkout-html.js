import fs from 'node:fs';
import path from 'node:path';

const src = 'D:/YOUPI PG/apps/checkout-portal/src/views/checkout.html';
const dest = 'D:/YOUPI PG-PRODUCTION/apps/checkout-portal/src/views/checkout.html';

console.log('Syncing checkout.html to Production...');
fs.copyFileSync(src, dest);
const stat = fs.statSync(dest);
console.log(`[✓] Successfully synced checkout.html (${stat.size} bytes) to ${dest}`);
