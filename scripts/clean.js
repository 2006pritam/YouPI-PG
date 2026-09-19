import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const targets = ['dist', 'node_modules/.cache', 'tsconfig.tsbuildinfo'];

function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === '.cache') {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed: ${fullPath}`);
      } else if (entry.name !== 'node_modules') {
        cleanDir(fullPath);
      }
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      fs.rmSync(fullPath, { force: true });
      console.log(`Removed: ${fullPath}`);
    }
  }
}

console.log('Cleaning build artifacts across workspace...');
cleanDir(root);
console.log('Clean complete.');
