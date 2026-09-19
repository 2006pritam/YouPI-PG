import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCheckoutServer } from '../index.js';
import { generateQrMatrix, generateQrSvg } from '../qr.js';

describe('Checkout Portal Integration Tests', () => {
  let serverInstance;
  let baseUrl;

  before(async () => {
    // Start on high test port (7199)
    serverInstance = await startCheckoutServer(7199);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('QR Generator', () => {
    test('generateQrMatrix creates 29x29 matrix with finder patterns', () => {
      const matrix = generateQrMatrix('upi://pay?pa=store@upi&am=200.00');
      assert.equal(matrix.length, 29);
      assert.equal(matrix[0].length, 29);

      // Verify top-left finder pattern corner
      assert.equal(matrix[0][0], 1);
      assert.equal(matrix[0][6], 1);
      assert.equal(matrix[6][0], 1);
      assert.equal(matrix[6][6], 1);
    });

    test('generateQrSvg creates clean, valid SVG markup', () => {
      const svg = generateQrSvg('upi://pay?pa=merchant@upi&am=500.00', 240);
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
      assert.ok(svg.includes('viewBox="0 0 240 240"'));
      assert.ok(svg.endsWith('</svg>'));
    });
  });

  describe('HTTP Endpoints', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'checkout-portal');
    });

    test('GET /checkout/:id renders responsive HTML with injected payment ID', async () => {
      const testPaymentId = 'pay_test_uuid_12345';
      const res = await get(`/checkout/${testPaymentId}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));

      assert.ok(res.text.includes('<!DOCTYPE html>'));
      assert.ok(res.text.includes('name="viewport"'));
      assert.ok(res.text.includes('PAYMENT_ID = "pay_test_uuid_12345"'));
      assert.ok(res.text.includes('PAYMENT DONE — CHECK MY PAYMENT'));
      assert.ok(res.text.includes('Payment Slot Queue'));
      assert.ok(res.text.includes('Payment Options'));
      assert.ok(res.text.includes('id="sidebarLogoImg"'));
      assert.ok(res.text.includes('id="footerGuaranteeText"'));
      assert.ok(res.text.includes('id="preGatewayAuthView"'));
      assert.ok(res.text.includes('id="paymentGatewayInterface"'));
      assert.ok(res.text.includes('id="tabPreAuthLoginBtn"'));
      assert.ok(res.text.includes('id="tabPreAuthRegisterBtn"'));
      assert.ok(res.text.includes('Customer Authentication'));
      assert.ok(res.text.includes('id="providerSection"'));
      assert.ok(res.text.includes('providers-grid-viewport'));
      assert.ok(res.text.includes('id="btnLaunchApp"'));

      // INVARIANT: Zero UPI Offer artifacts
      assert.equal(res.text.includes('6 Offers'), false);
      assert.equal(res.text.includes('View Offers'), false);
      assert.equal(res.text.includes('id="checkoutNoticeText"'), false);
      assert.equal(res.text.includes('available-offers-card'), false);
    });

    test('GET /checkout/:id/qr.svg returns dynamic SVG image', async () => {
      const res = await get('/checkout/pay_test_uuid_12345/qr.svg');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('image/svg+xml'));
      assert.ok(res.text.includes('<svg'));
      assert.ok(res.text.includes('</svg>'));
    });
  });
});
