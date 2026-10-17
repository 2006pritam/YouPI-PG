import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQrSvg } from './qr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes a value for interpolation into HTML text or a quoted attribute.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Escapes a value for interpolation into a JavaScript string literal.
 * HTML escaping is useless inside <script>: the parser never decodes entities
 * there, so `</script>` and a bare quote would break out of the literal.
 */
export function escapeJsString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Serialises a value as JSON that is safe to embed in a <script> block.
 * Only `<` matters for tag termination, but U+2028/U+2029 are literal line
 * terminators in older JS parsers, so they are escaped too.
 */
export function serializeForScript(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Placeholders that land inside a <script> block rather than HTML markup.
const SCRIPT_PLACEHOLDERS = new Set(['PAYMENT_ID', 'API_BASE_URL', 'AMOUNT']);

/**
 * The checkout page is designed to be embedded by merchant storefronts, so the
 * framing allowlist has to be deployment specific. Deployments can pin it with
 * CHECKOUT_FRAME_ANCESTORS (e.g. "https://shop.example.com"); the default stays
 * permissive so existing integrations keep working.
 */
export function resolveFrameAncestors() {
  const configured = (process.env.CHECKOUT_FRAME_ANCESTORS || '').trim();
  return configured || '*';
}

/**
 * Replaces {{PLACEHOLDER}} tokens in the checkout template.
 *
 * The replacement is done with a replacer function so that `$&`, `$'` and `` $` ``
 * inside an attacker-controlled value are inserted literally instead of being
 * expanded as replacement patterns.
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    return SCRIPT_PLACEHOLDERS.has(key) ? escapeJsString(value) : escapeHtml(value);
  });
}

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
    try {
      const rootEnv = path.resolve(__dirname, '../../../.env');
      if (fs.existsSync(rootEnv)) {
        const raw = fs.readFileSync(rootEnv, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('BASE_PAYMENT_API_URL=')) {
            const val = trimmed.split('=')[1]?.trim();
            if (val) process.env.BASE_PAYMENT_API_URL = val.replace(/^["']|["']$/g, '');
          }
        }
      }
    } catch {}

    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.htmlTemplatePath = path.join(__dirname, 'views', 'checkout.html');
    this.sdkScriptPath = path.join(__dirname, 'sdk', 'youpi-checkout.js');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  async fetchPaymentState(paymentId) {
    try {
      const internalPort = process.env.PAYMENT_API_PORT || 6100;
      const res = await fetch(`http://127.0.0.1:${internalPort}/api/v1/checkout/${paymentId}/state`, {
        headers: { 'X-Internal-Render': 'true' }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  renderHtml(paymentId, state) {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    const appName = state?.branding?.appName || 'YouPI PG';
    const primaryColor = state?.branding?.primaryColor || '#0b63e5';
    const merchantName = state?.merchantName || 'Merchant Checkout';
    const orderId = state?.orderId || '';
    const logoUrl = state?.branding?.logoUrl || '';
    const sidebarNotice = state?.branding?.sidebarNotice || 'Fast & Secure 256-Bit Encrypted Payments';
    const counterInstructions = state?.branding?.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.';
    const vpa = state?.payeeVpa || state?.vpa || 'merchant@upi';

    // In production and localhost, use relative '' so browser requests hit the checkout portal /api proxy
    // This avoids cross-origin blocking, CORS errors, and tunnel DNS resolution issues.
    const clientApiBase = '';

    const indicator = state?.upiServerIndicator || { status: 'ISSUES', tier: 'RED', label: 'Server Facing Issues' };
    const tier = indicator.tier || (indicator.status === 'WORKING' ? 'GREEN' : (indicator.status === 'BUSY' ? 'YELLOW' : 'RED'));
    const healthClass = tier === 'GREEN' ? 'is-working' : (tier === 'YELLOW' ? 'is-busy' : 'is-issues');
    const healthLabel = indicator.label || (tier === 'GREEN' ? 'Server Is Working' : (tier === 'YELLOW' ? 'UPI Server Busy' : 'Server Facing Issues'));
    const alertStyle = tier === 'GREEN' ? 'none' : 'flex';
    const alertClass = tier === 'YELLOW' ? 'ypg-downtime-alert is-warning' : 'ypg-downtime-alert';
    const alertHeading = tier === 'YELLOW' ? 'UPI Server Busy' : 'UPI Server Facing Issues';
    const alertMsg = indicator.warning || (tier === 'YELLOW'
      ? 'Your payment may go through extra processing seconds.'
      : 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.');

    const sellingMode = state?.sellingMode || state?.branding?.sellingMode || 'ONLINE';
    const enabledMethods = state?.enabledMethods || state?.branding?.enabledPaymentMethods || ['UPI'];
    const showMethodBar = (enabledMethods && enabledMethods.length > 1) ? 'flex' : 'none';
    const tabCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:inline-flex;' : 'display:none;';
    const tabCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const tabCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:inline-flex;' : 'display:none;';
    const pcCodStyle = (sellingMode === 'ONLINE' && enabledMethods.includes('COD')) ? 'display:block;' : 'display:none;';
    const pcCashStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER')) ? 'display:block;' : 'display:none;';
    const pcCardStyle = (sellingMode === 'OFFLINE' && enabledMethods.includes('CARD_COUNTER')) ? 'display:block;' : 'display:none;';

    const downtimeAltBtnDisplay = ((sellingMode === 'ONLINE' && enabledMethods.includes('COD')) || (sellingMode === 'OFFLINE' && enabledMethods.includes('CASH_COUNTER'))) ? 'inline-block' : 'none';
    const downtimeAltBtnLabel = (sellingMode === 'ONLINE') ? 'Pay via Cash on Delivery Instead' : 'Pay by Cash at Till Instead';

    return renderTemplate(this.template, {
      PAYMENT_ID: paymentId,
      API_BASE_URL: clientApiBase,
      APP_NAME: appName,
      PRIMARY_COLOR: primaryColor,
      MERCHANT_NAME: merchantName,
      ORDER_ID: orderId,
      AMOUNT: state?.amount || '0.00',
      VPA: vpa,
      LOGO_URL: logoUrl,
      SIDEBAR_NOTICE: sidebarNotice,
      COUNTER_INSTRUCTIONS: counterInstructions,
      SERVER_HEALTH_CLASS: healthClass,
      SERVER_HEALTH_LABEL: healthLabel,
      DOWNTIME_ALERT_STYLE: alertStyle,
      DOWNTIME_ALERT_CLASS: alertClass,
      DOWNTIME_HEADING: alertHeading,
      DOWNTIME_MSG: alertMsg,
      METHOD_SELECTOR_DISPLAY: showMethodBar,
      TAB_COD_STYLE: tabCodStyle,
      TAB_CASH_STYLE: tabCashStyle,
      TAB_CARD_STYLE: tabCardStyle,
      PC_COD_STYLE: pcCodStyle,
      PC_CASH_STYLE: pcCashStyle,
      PC_CARD_STYLE: pcCardStyle,
      DOWNTIME_ALT_BTN_DISPLAY: downtimeAltBtnDisplay,
      DOWNTIME_ALT_BTN_LABEL: downtimeAltBtnLabel,
      INITIAL_STATE_JSON: serializeForScript(state || {})
    });
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

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = Number(process.env.PAYMENT_API_PORT || 6100);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${targetPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Official SDK script: GET /youpi.js or /sdk/youpi-checkout.js
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi.js' || pathname === '/sdk/youpi-checkout.js') {
        try {
          const resolvedSdkPath = fs.existsSync(path.join(__dirname, 'sdk', 'youpi.js'))
            ? path.join(__dirname, 'sdk', 'youpi.js')
            : this.sdkScriptPath;
          const sdkContent = fs.readFileSync(resolvedSdkPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(sdkContent);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading SDK: ' + err.message);
        }
        return;
      }

      // Static icons: GET /icons/:filename
      if (pathname.startsWith('/icons/')) {
        const iconName = path.basename(pathname);
        const iconPath = path.join(__dirname, '..', 'public', 'icons', iconName);
        if (fs.existsSync(iconPath)) {
          const ext = path.extname(iconName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(iconPath).pipe(res);
          return;
        }
      }

      // QR SVG: GET /checkout/:id/qr.svg (Direct from merchant receiving account)
      const qrMatch = pathname.match(/^\/checkout\/([^/]+)\/qr\.svg$/);
      if (qrMatch) {
        const paymentId = qrMatch[1];
        const state = await this.fetchPaymentState(paymentId);
        const upiUri = state?.upiUri || `upi://pay?pa=${encodeURIComponent(state?.payeeVpa || 'merchant@upi')}&pn=${encodeURIComponent(state?.merchantName || 'Store')}&am=${encodeURIComponent(state?.amount || '100.00')}&tn=${encodeURIComponent(paymentId)}`;

        const svg = generateQrSvg(upiUri, 220);
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
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
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*',
          'Content-Security-Policy': `frame-ancestors ${resolveFrameAncestors()}`
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
