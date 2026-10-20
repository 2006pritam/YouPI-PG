import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';
import { WebhookEngine } from '@youpi/core';

describe('Gateway Hardening & Invariant Protection Test Suite (#23, #25, #26, #27, #28)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6291, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...authHeadersFor(path), ...(options.headers || {}) }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Issue #23: Checkout state sanitizes branding and never exposes gmailConfig or tunnel command to customer', async () => {
    // Inject internal credentials into merchant branding
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const dangerousBranding = {
      appName: 'Secure Test Gateway',
      primaryColor: '#0ea5e9',
      gmailConfig: {
        clientId: 'google-client-id-xyz',
        clientSecret: 'secret-oauth-key-12345',
        refreshToken: 'refresh-token-token'
      },
      cloudflareTunnelCommand: 'cloudflared tunnel run --token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      webhookSecret: 'shh-private-webhook-secret',
      adminToken: 'super-secret-admin-pass'
    };

    testDb.execute('UPDATE merchants SET branding = ? WHERE id = ?', [
      JSON.stringify(dangerousBranding),
      merchantId
    ]);

    // Create a payment session
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-LEAK-TEST-01',
        amount: '100.00',
        autoActivate: true
      }
    });

    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    // Fetch public checkout state as a customer
    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.status, 200);

    const branding = stateRes.body.branding;
    assert.ok(branding, 'Branding must be present in checkout state');
    assert.equal(branding.appName, 'Secure Test Gateway');
    assert.equal(branding.primaryColor, '#0ea5e9');

    // CRITICAL SECURITY INVARIANT: No credentials leaked to customer
    assert.equal(branding.gmailConfig, undefined, 'gmailConfig must NEVER be leaked to customer checkout state');
    assert.equal(branding.cloudflareTunnelCommand, undefined, 'cloudflareTunnelCommand must NEVER be leaked to customer checkout state');
    assert.equal(branding.webhookSecret, undefined, 'webhookSecret must NEVER be leaked to customer checkout state');
    assert.equal(branding.adminToken, undefined, 'adminToken must NEVER be leaked to customer checkout state');
  });

  test('Issue #26: COD is disabled by default and rejected unless merchant explicitly opted in', async () => {
    // Ensure default merchant has NO enabledPaymentMethods set (defaults to UPI only)
    const merchantId = '00000000-0000-0000-0000-000000000001';
    testDb.execute('UPDATE merchants SET branding = ? WHERE id = ?', [
      JSON.stringify({ appName: 'No COD Gateway', sellingMode: 'ONLINE' }),
      merchantId
    ]);

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-COD-BLOCKED-01',
        amount: '250.00',
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);

    // Attempting to confirm COD without explicit opt-in must be rejected
    const codRes = await request(`/api/v1/checkout/${payRes.body.paymentId}/confirm-cod`, {
      method: 'POST'
    });
    assert.equal(codRes.status, 400);
    assert.ok(codRes.body.error.includes('disabled by merchant'));
  });

  test('Issue #27: Receiving account blocks UPI ID mutation while slot is busy serving an active payment', () => {
    const accountRepo = apiInstance.app.context.accountRepo;
    const account = accountRepo.findByMerchantId('00000000-0000-0000-0000-000000000001')[0];
    assert.ok(account);

    // Simulate busy slot
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 1, current_active_session_id = ? WHERE id = ?', [
      'session-active-123',
      account.id
    ]);

    // Updating name or active flag is allowed
    assert.doesNotThrow(() => {
      accountRepo.updateAccount(account.id, { payeeName: 'Updated Name Safe' });
    });

    // Mutating UPI ID while slot is busy MUST THROW
    assert.throws(() => {
      accountRepo.updateAccount(account.id, { upiId: 'hijacked@upi' });
    }, /Cannot change UPI ID while receiving account slot is currently busy/);

    // Reset slot
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [
      account.id
    ]);
  });

  test('Issue #27: Active checkout session adheres immutably to snapshot VPA if receiving account is modified', async () => {
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-SNAPSHOT-LOCK-01',
        amount: '499.00',
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    const stateBefore = await request(`/api/v1/checkout/${paymentId}/state`);
    const originalVpa = stateBefore.body.payeeVpa;
    assert.ok(originalVpa);

    // Now simulate an out-of-band DB mutation to the receiving account's upi_id
    const accountId = stateBefore.body.receivingAccountId;
    testDb.execute('UPDATE payment_receiving_accounts SET upi_id = ? WHERE id = ?', [
      'mutated-afterwards@upi',
      accountId
    ]);

    // The open checkout session must still render the original snapshot VPA!
    const stateAfter = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateAfter.body.payeeVpa, originalVpa, 'Checkout session must render immutable snapshot VPA, not live mutated VPA');
  });

  test('Issue #26: WebhookEngine dispatches payload with method, verificationTag, and verificationLevel', async () => {
    let receivedPayload = null;
    const mockReceiver = http.createServer((req, res) => {
      let b = '';
      req.on('data', chunk => { b += chunk; });
      req.on('end', () => {
        receivedPayload = JSON.parse(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    await new Promise(r => mockReceiver.listen(0, r));
    const port = mockReceiver.address().port;

    const merchantRepo = apiInstance.app.context.merchantRepo;
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const testMerchant = merchantRepo.create({
      businessName: 'Webhook Hardening Store',
      slug: 'webhook-hardened',
      contactEmail: 'hardened@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${port}/hook`,
      webhookSecret: 'super-secret-key-999'
    });

    const session = sessionRepo.create({
      merchantId: testMerchant.id,
      orderId: 'HOOK-VERIFY-01',
      amountPaise: 75000n,
      method: 'UPI',
      verificationTag: 'L2_SMS_GMAIL_DUAL_MATCH',
      verificationLevel: 2
    });

    testDb.execute(
      "UPDATE payment_sessions SET verification_tag = 'L2_SMS_GMAIL_DUAL_MATCH', verification_level = 2, method = 'UPI' WHERE id = ?",
      [session.id]
    );
    const verifiedSession = sessionRepo.findById(session.id);

    const engine = new WebhookEngine({
      db: testDb,
      merchantRepo: merchantRepo
    });

    const dispatchResult = await engine.dispatch('SUCCESS', verifiedSession);
    assert.equal(dispatchResult.delivered, true);

    await new Promise(cb => mockReceiver.close(cb));

    assert.ok(receivedPayload);
    assert.equal(receivedPayload.event, 'SUCCESS');
    assert.equal(receivedPayload.method, 'UPI');
    assert.equal(receivedPayload.verificationTag, 'L2_SMS_GMAIL_DUAL_MATCH');
    assert.equal(receivedPayload.verificationLevel, 2);
  });
});
