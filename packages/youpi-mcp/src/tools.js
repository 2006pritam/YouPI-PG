import crypto from 'node:crypto';
import http from 'node:http';

export const TOOLS_DEFINITIONS = [
  {
    name: 'youpi_check_gateway_health',
    description: 'Check the health and operational status of all local YouPI PG services (Payment Core API, Checkout Portal, Observers).',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Host to check (defaults to 127.0.0.1)',
          default: '127.0.0.1'
        }
      }
    }
  },
  {
    name: 'youpi_verify_webhook',
    description: 'Verify HMAC-SHA256 signature for a YouPI PG webhook delivery payload.',
    inputSchema: {
      type: 'object',
      properties: {
        rawPayload: {
          type: 'string',
          description: 'The raw, unparsed request payload string'
        },
        signature: {
          type: 'string',
          description: 'The received X-Gateway-Signature header (sha256=<hex>)'
        },
        secret: {
          type: 'string',
          description: 'The merchant webhook secret'
        },
        timestamp: {
          type: 'string',
          description: 'The received X-Gateway-Timestamp header in ms'
        },
        maxAgeSeconds: {
          type: 'number',
          description: 'Maximum permitted age in seconds (default 300)',
          default: 300
        }
      },
      required: ['rawPayload', 'signature', 'secret']
    }
  },
  {
    name: 'youpi_simulate_bank_notification',
    description: 'Simulate an incoming Indian bank SMS credit notification to test automated payment verification.',
    inputSchema: {
      type: 'object',
      properties: {
        bank: {
          type: 'string',
          enum: ['HDFC', 'SBI', 'ICICI', 'AXIS', 'KOTAK', 'PNB'],
          description: 'Target bank sender template to format'
        },
        amount: {
          type: 'number',
          description: 'Amount in INR (e.g. 499.00)'
        },
        utr: {
          type: 'string',
          description: '12-digit bank reference number (UTR / RRN)'
        },
        accountLastDigits: {
          type: 'string',
          description: 'Last 3-4 digits of receiving account',
          default: '1234'
        },
        observerPort: {
          type: 'number',
          description: 'SMS Observer port (default 6002)',
          default: 6002
        }
      },
      required: ['bank', 'amount', 'utr']
    }
  }
];

export function verifyWebhookSignature({ rawPayload, signature, secret, timestamp, maxAgeSeconds = 300 }) {
  if (!rawPayload || !signature || !secret) {
    return { valid: false, error: 'MISSING_REQUIRED_PARAMS' };
  }

  if (timestamp) {
    const tsNum = Number(timestamp);
    if (!Number.isNaN(tsNum)) {
      const now = Date.now();
      const diffMs = Math.abs(now - tsNum);
      if (diffMs > maxAgeSeconds * 1000) {
        return { valid: false, error: 'WEBHOOK_TIMESTAMP_EXPIRED', ageSeconds: Math.round(diffMs / 1000) };
      }
    }
  }

  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-fA-F]+$/.test(sig) || sig.length % 2 !== 0) {
    return { valid: false, error: 'INVALID_SIGNATURE_FORMAT' };
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawPayload, 'utf8');
  const expected = hmac.digest('hex');

  const bufA = Buffer.from(sig, 'hex');
  const bufB = Buffer.from(expected, 'hex');

  if (bufA.length !== bufB.length) {
    return { valid: false, error: 'SIGNATURE_LENGTH_MISMATCH' };
  }

  const matches = crypto.timingSafeEqual(bufA, bufB);
  return { valid: matches, error: matches ? null : 'INVALID_SIGNATURE' };
}

export function generateBankSmsText({ bank, amount, utr, accountLastDigits = '1234' }) {
  const amtFormatted = Number(amount).toFixed(2);
  switch (bank.toUpperCase()) {
    case 'HDFC':
      return `Dear Customer, INR ${amtFormatted} credited to account **${accountLastDigits} on ${new Date().toISOString().slice(0, 10)} by UPI/${utr}/YouPI. Avl bal INR 25,000.00.`;
    case 'SBI':
      return `Your A/C ${accountLastDigits} Credited by Rs ${amtFormatted} on ${new Date().toISOString().slice(0, 10)} by UPI/Ref no ${utr} - SBI.`;
    case 'ICICI':
      return `Dear Customer, Acct XX${accountLastDigits} is credited with Rs ${amtFormatted} on ${new Date().toISOString().slice(0, 10)}. UPI:${utr}.`;
    case 'AXIS':
      return `INR ${amtFormatted} credited to Axis Bank A/c no. XX${accountLastDigits} on ${new Date().toISOString().slice(0, 10)} by UPI ref ${utr}.`;
    case 'KOTAK':
      return `Rs ${amtFormatted} credited to Kotak Bank A/C XX${accountLastDigits} on ${new Date().toISOString().slice(0, 10)} (UPI Ref no ${utr}).`;
    case 'PNB':
      return `A/C *${accountLastDigits} credited with INR ${amtFormatted} on ${new Date().toISOString().slice(0, 10)} via UPI/${utr}. PNB.`;
    default:
      return `Credit of INR ${amtFormatted} received in A/C *${accountLastDigits} via UPI ref ${utr}.`;
  }
}

export async function checkPortHealth(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/health', method: 'GET', timeout: 800 }, (res) => {
      resolve({ port, online: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on('error', (err) => {
      req.destroy();
      resolve({ port, online: false, error: err.code || 'CONNECTION_REFUSED' });
    });
    req.on('timeout', () => { req.destroy(); resolve({ port, online: false, error: 'TIMEOUT' }); });
    req.end();
  });
}
