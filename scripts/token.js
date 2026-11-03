// Prints the admin sign-in token:  npm run token
import './load-env.js';
import { getAdminToken } from '../packages/common/src/index.js';

console.log(`\nAdmin token (paste it into the admin panel at http://localhost:6001):\n\n  ${getAdminToken()}\n`);
