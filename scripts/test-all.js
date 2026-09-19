import { spawnSync } from 'node:child_process';

const testFiles = [
  'packages/common/src/__tests__/common.test.js',
  'packages/db/src/__tests__/customer-reset.test.js',
  'packages/db/src/__tests__/auth-matrix.test.js',
  'packages/db/src/__tests__/db.test.js',
  'packages/core/src/__tests__/core.test.js',
  'packages/core/src/__tests__/queue-timing.test.js',
  'packages/core/src/__tests__/webhook-engine.test.js',
  'apps/payment-api/src/__tests__/payment-api.test.js',
  'apps/payment-api/src/__tests__/counter-payments.test.js',
  'apps/checkout-portal/src/__tests__/checkout-portal.test.js',
  'apps/merchant-admin/src/__tests__/merchant-admin.test.js',
  'apps/payment-help/src/__tests__/payment-help.test.js',
  'apps/gmail-observer/src/__tests__/gmail-observer.test.js',
  'apps/sms-observer/src/__tests__/sms-observer.test.js',
  'apps/coin-wallet-store/src/__tests__/coin-wallet-store.test.js',
  'packages/merchant-sdk/src/__tests__/merchant-sdk.test.js',
  'scripts/chaos-concurrency.test.js'
];

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  env: process.env
});

process.exit(result.status ?? 0);
