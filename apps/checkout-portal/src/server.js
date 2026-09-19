import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQrSvg } from './qr.js';

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

export class CheckoutServer {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   helpPortalUrl?: string
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.helpPortalUrl = options.helpPortalUrl || process.env.BASE_HELP_URL || 'http://localhost:3000';
    this.htmlTemplatePath = path.join(__dirname, 'views', 'checkout.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  async fetchPaymentState(paymentId) {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/checkout/${paymentId}/state`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  renderHtml(paymentId, state) {
    let html = this.template;

    const appName = state?.branding?.appName || 'YOUPI PG';
    const primaryColor = state?.branding?.primaryColor || '#2563eb';
    const merchantName = state?.merchantName || 'Merchant Checkout';
    const orderId = state?.orderId || '';
    const logoUrl = state?.branding?.logoUrl || '';
    const sidebarNotice = state?.branding?.sidebarNotice || 'Fast & Secure 256-Bit Encrypted Payments';
    const footerGuarantee = state?.branding?.footerGuarantee || `Secured by ${appName}`;
    const counterInstructions = state?.branding?.counterInstructions || 'Please visit the store billing counter and present this screen to the cashier.';

    html = html.replaceAll('{{PAYMENT_ID}}', paymentId);
    html = html.replaceAll('{{API_BASE_URL}}', this.apiBaseUrl);
    html = html.replaceAll('{{HELP_PORTAL_URL}}', this.helpPortalUrl);
    html = html.replaceAll('{{APP_NAME}}', appName);
    html = html.replaceAll('{{PRIMARY_COLOR}}', primaryColor);
    html = html.replaceAll('{{MERCHANT_NAME}}', merchantName);
    html = html.replaceAll('{{ORDER_ID}}', orderId);
    html = html.replaceAll('{{AMOUNT}}', state?.amount || '0.00');
    html = html.replaceAll('{{LOGO_URL}}', logoUrl);
    html = html.replaceAll('{{SIDEBAR_NOTICE}}', sidebarNotice);
    html = html.replaceAll('{{FOOTER_GUARANTEE}}', footerGuarantee);
    html = html.replaceAll('{{COUNTER_INSTRUCTIONS}}', counterInstructions);

    return html;
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'checkout-portal' }));
        return;
      }

      // QR SVG: GET /checkout/:id/qr.svg
      const qrMatch = pathname.match(/^\/checkout\/([^/]+)\/qr\.svg$/);
      if (qrMatch) {
        const paymentId = qrMatch[1];
        const state = await this.fetchPaymentState(paymentId);
        const upiUri = state?.upiUri || `upi://pay?pa=payee%40upi&pn=Store&am=200.00&tn=${paymentId}`;

        const svg = generateQrSvg(upiUri, 220);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(svg);
        return;
      }

      // Checkout Page: GET /checkout/:id
      const checkoutMatch = pathname.match(/^\/checkout\/([^/]+)$/);
      if (checkoutMatch) {
        const paymentId = checkoutMatch[1];
        const state = await this.fetchPaymentState(paymentId);

        const rendered = this.renderHtml(paymentId, state);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(rendered);
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Checkout Page Not Found');
    });
  }
}
