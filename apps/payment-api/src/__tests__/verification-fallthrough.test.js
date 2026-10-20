import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Verification Pipeline & Fall-Through Protection (#22)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6295, testDb);
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

  test('Issue #22: Poller endpoints reject personal numeric SMS senders and do not fall through to attribution', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    const session = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'FALLTHROUGH-GUARD-01',
      amountPaise: 50000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

    // Personal numeric SMS sender (+919876543210) attempts to inject payment
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: '+919876543210',
        receivingAccountId,
        amount: '500.00',
        amountPaise: '50000',
        rawText: 'A/C 1234 credited by Rs 500.00 via UPI/123456789012'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'PERSONAL_SMS_REJECTED');

    // Confirm session remains ACTIVE (not marked SUCCESS)
    const freshSession = sessionRepo.findById(session.id);
    assert.equal(freshSession.status, PaymentStatus.ACTIVE);
  });

  test('Issue #22: Poller endpoints reject duplicate/reused bank reference number (UTR)', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const obsRepo = apiInstance.app.context.obsRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // 1. Session 1 is already completed with UTR 123456123456
    const priorObs = obsRepo.create({
      source: 'SMS',
      receivingAccountId,
      amountPaise: 10000n,
      amount: '100.00',
      observedAt: new Date(),
      bankReferenceNumber: '123456123456',
      fingerprintHash: 'hash-utr-consumed-test-999'
    });
    const s1 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'PRIOR-ORDER-99',
      amountPaise: 10000n
    });
    testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [priorObs.id, s1.id]);

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    // 2. Session 2 is currently active for ₹100
    const s2 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'NEW-ORDER-100',
      amountPaise: 10000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s2.id, receivingAccountId);

    // 3. Ingest observation reusing the same UTR
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        receivingAccountId,
        amount: '100.00',
        amountPaise: '10000',
        bankReferenceNumber: '123456123456',
        rawText: 'A/C credited with Rs 100.00 on 19-Oct-2026. Ref: 123456123456'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'REFERENCE_ALREADY_USED');

    // Confirm s2 is not attributed
    const freshS2 = sessionRepo.findById(s2.id);
    assert.equal(freshS2.status, PaymentStatus.ACTIVE);
  });
});
