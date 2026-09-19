import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CoinWalletStoreServer {
  /**
   * @param {{
   *   gatewayApiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string
   * }} [options={}]
   */
  constructor(options = {}) {
    this.gatewayApiUrl = options.gatewayApiUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.merchantId = options.merchantId || '00000000-0000-0000-0000-000000000001';
    this.webhookSecret = options.webhookSecret || 'merchant_webhook_secret_for_wallet_store';

    this.paymentClient = new YoupiPaymentClient({
      apiUrl: this.gatewayApiUrl,
      merchantId: this.merchantId,
      webhookSecret: this.webhookSecret
    });

    // In-memory persistent wallet balance & ledger for demo store
    this.walletCoins = 50; // default starting balance
    this.transactionHistory = [];

    this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8');
    this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8');
    this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8');
  }

  creditCoins(orderId, coins, packName) {
    this.walletCoins += Number(coins);
    this.transactionHistory.unshift({
      orderId,
      packName: packName || 'Coin Pack',
      coins: Number(coins),
      status: 'CREDITED',
      timestamp: new Date().toISOString()
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Gateway-Signature, X-Gateway-Event'
        });
        res.end();
        return;
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'coin-wallet-store', coins: this.walletCoins }));
        return;
      }

      // GET / or /store
      if ((pathname === '/' || pathname === '/store') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.storeHtml);
        return;
      }

      // GET /wallet
      if (pathname === '/wallet' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.walletHtml);
        return;
      }

      // GET /order-failed
      if (pathname === '/order-failed' && method === 'GET') {
        const orderId = url.searchParams.get('orderId') || 'ORDER-#';
        const rendered = this.orderFailedHtml.replaceAll('ORDER-#', orderId);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(rendered);
        return;
      }

      // GET /api/wallet-balance
      if (pathname === '/api/wallet-balance' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          coins: this.walletCoins,
          history: this.transactionHistory
        }));
        return;
      }

      // POST /api/checkout (Customer clicks purchase pack)
      if (pathname === '/api/checkout' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            if (!data.price || Number(data.price) < 1) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Minimum top-up amount is ₹1.00' }));
              return;
            }
            const orderId = `COIN-ORD-${Date.now()}`;
            const amountStr = Number(data.price).toFixed(2);
            const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('example.com') ? 'https' : 'http');
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
            const returnUrl = `${proto}://${host}/wallet?orderId=${orderId}`;

            // Call YOUPI Payment Gateway via SDK (Identity-agnostic: merchant does not collect customer auth)
            const payment = await this.paymentClient.createPayment({
              orderId,
              amount: amountStr,
              currency: 'INR',
              returnUrl,
              metadata: {
                coins: data.coins,
                packName: data.packName
              }
            });

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              orderId,
              paymentId: payment.paymentId,
              checkoutUrl: payment.checkoutUrl
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/webhook (Signed webhook listener from YOUPI PG)
      if (pathname === '/api/webhook' && method === 'POST') {
        let rawBody = '';
        req.on('data', chunk => { rawBody += chunk; });
        req.on('end', () => {
          const signature = req.headers['x-gateway-signature'];

          try {
            // Verify HMAC-SHA256 signature using merchant SDK
            const event = this.paymentClient.verifyWebhook(rawBody, signature);

            if (event.event === 'SUCCESS') {
              const coinsToAdd = event.metadata?.coins || 100;
              const packName = event.metadata?.packName || 'Coin Pack';
              this.creditCoins(event.orderId, coinsToAdd, packName);
              console.log(`[Coin Wallet Store] Webhook received! Credited ${coinsToAdd} coins for Order ${event.orderId}. New balance: ${this.walletCoins}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, credited: event.event === 'SUCCESS' }));
          } catch (err) {
            console.error('[Coin Wallet Store] Webhook verification failed:', err.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Route Not Found');
    });
  }
}
