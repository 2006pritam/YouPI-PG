import { runMigrations } from '../packages/db/src/migrate.js';
import { startControlCenter } from '../apps/control-center/src/index.js';

console.log('====================================================');
console.log('🚀 Starting YOUPI PG (Self-Hosted Payment Gateway)');
console.log('====================================================');

// 1. Run database migrations & seeds
console.log('[1/2] Checking and applying database migrations...');
const migrationResult = runMigrations();
console.log(`[✓] Database ready. Default merchant: ${migrationResult.defaultMerchant.businessName}`);

// 2. Start Control Center supervisor and launch all services
console.log('[2/2] Launching Local Process Control Center on port 8090...');
const cc = await startControlCenter(8090);

console.log('\n[✓] Control Center is online at: http://localhost:8090');
console.log('[*] Starting all modular gateway services...\n');

await cc.processManager.startAll();

console.log('====================================================');
console.log('🟢 ALL SERVICES ONLINE & OPERATIONAL');
console.log('====================================================');
console.log('• Control Center Console:     http://localhost:8090');
console.log('• Payment Core REST API:      http://localhost:6100');
console.log('• Customer Checkout Portal:   http://localhost:7000/checkout/:id');
console.log('• Merchant Admin Dashboard:   http://localhost:6001');
console.log('• Customer Payment Help:      http://localhost:3000');
console.log('• Gmail Payment Observer:     http://localhost:6003');
console.log('• Google Messages / SMS Obs:  http://localhost:6002');
console.log('====================================================');
console.log('Press Ctrl+C to stop all services gracefully.');

// Handle graceful shutdown
const shutdown = async () => {
  console.log('\nStopping all services gracefully...');
  await cc.close();
  console.log('All processes terminated cleanly.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
