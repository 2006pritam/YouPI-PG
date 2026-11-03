import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MIN_NODE = { major: 22, minor: 13 };

/** Service ports the gateway needs, honouring the same env vars the supervisor reads. */
export function servicePorts(env = process.env) {
  return [
    { name: 'Control Center', port: Number(env.CONTROL_CENTER_PORT || 8090), envVar: 'CONTROL_CENTER_PORT' },
    { name: 'Merchant Admin', port: Number(env.MERCHANT_ADMIN_PORT || 6001), envVar: 'MERCHANT_ADMIN_PORT' },
    { name: 'Payment API', port: Number(env.PAYMENT_API_PORT || 6100), envVar: 'PAYMENT_API_PORT' },
    { name: 'Checkout Portal', port: Number(env.CHECKOUT_PORTAL_PORT || 7000), envVar: 'CHECKOUT_PORTAL_PORT' },
    { name: 'Demo Store', port: Number(env.COIN_STORE_PORT || env.COIN_WALLET_STORE_PORT || 5000), envVar: 'COIN_STORE_PORT' },
    { name: 'SMS Observer', port: Number(env.SMS_OBSERVER_PORT || 6002), envVar: 'SMS_OBSERVER_PORT' },
    { name: 'Gmail Observer', port: Number(env.GMAIL_OBSERVER_PORT || 6003), envVar: 'GMAIL_OBSERVER_PORT' }
  ];
}

/** Returns { ok, current } for the running Node version against MIN_NODE. */
export function checkNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return { ok, current: version };
}

/** Copies .env.example to .env when .env is missing. Returns true if it created the file. */
export function ensureEnvFile() {
  const envFile = path.join(rootDir, '.env');
  const example = path.join(rootDir, '.env.example');
  if (fs.existsSync(envFile) || !fs.existsSync(example)) return false;
  fs.copyFileSync(example, envFile);
  return true;
}

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

/** Returns the subset of services whose port is already taken by another process. */
export async function findBusyPorts(env = process.env) {
  const busy = [];
  for (const svc of servicePorts(env)) {
    if (!(await isPortFree(svc.port))) busy.push(svc);
  }
  return busy;
}

/** Prints a clear, actionable message for ports that are in use. */
export function printBusyPorts(busy) {
  console.error('\n❌ Some ports are already in use, so YOUPI PG cannot start:\n');
  for (const svc of busy) {
    console.error(`   • ${svc.name.padEnd(16)} port ${svc.port}  (change it with ${svc.envVar}=<free port> in .env)`);
  }
  console.error('\n   Most often a previous run is still going. Stop it (Ctrl+C in its terminal) and try again.\n');
}
