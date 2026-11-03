// Side-effect module: loads <repo>/.env into process.env (existing env vars win).
// Import it FIRST in an entry script so every later import sees the configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(rootDir, '.env');

try {
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  }
} catch {
  // A malformed .env must not stop the app from starting with defaults.
}
