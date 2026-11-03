// One-command first-run setup:  npm install && npm run setup
import './load-env.js';
import { checkNodeVersion, ensureEnvFile, findBusyPorts, MIN_NODE, rootDir } from './preflight.js';
import fs from 'node:fs';
import path from 'node:path';

const line = '─'.repeat(60);
console.log(`\n${line}\n  YOUPI PG — first-run setup\n${line}`);

// 1. Node version
const node = checkNodeVersion();
if (!node.ok) {
  console.error(`\n❌ Node.js ${MIN_NODE.major}.${MIN_NODE.minor}+ is required (you have ${node.current}).`);
  console.error('   Install the current LTS from https://nodejs.org and run this again.\n');
  process.exit(1);
}
console.log(`✔ Node.js ${node.current}`);

// 2. .env file
console.log(ensureEnvFile() ? '✔ Created .env from .env.example' : '✔ .env already exists (left untouched)');

// 3. Data directory + database
fs.mkdirSync(path.join(rootDir, 'data'), { recursive: true });
let adminToken;
try {
  const { runMigrations } = await import('../packages/db/src/migrate.js');
  const { getAdminToken } = await import('../packages/common/src/index.js');
  const result = runMigrations();
  adminToken = getAdminToken();
  console.log(`✔ Database ready (merchant: ${result.defaultMerchant.businessName})`);
  console.log('✔ Secure keys generated in data/.secrets/');
} catch (err) {
  console.error(`\n❌ Could not prepare the database: ${err.message}`);
  console.error('   Did you run "npm install" first?\n');
  process.exit(1);
}

// 4. Ports
const busy = await findBusyPorts();
if (busy.length) {
  console.log(`⚠ ${busy.length} port(s) are in use right now: ${busy.map(b => b.port).join(', ')}`);
  console.log('  (fine if YOUPI PG is already running; otherwise change them in .env)');
} else {
  console.log('✔ All service ports are free');
}

console.log(`
${line}
  Setup complete. Next:

  1. Start everything:     npm run dev
  2. Open the admin panel: http://localhost:6001
  3. Sign in with this admin token (shown only on this machine):

       ${adminToken}

     Lost it? Run "npm run token" any time.
${line}
`);
