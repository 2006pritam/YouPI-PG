import http from 'node:http';
import { GmailPoller } from './gmail-poller.js';
import { GmailBrowserAutomator } from './browser-automator.js';

export class GmailObserverServer {
  /**
   * @param {{
   *   poller?: GmailPoller,
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string
   * }} options
   */
  constructor(options = {}) {
    this.poller = options.poller || new GmailPoller(options);
    this.automator = new GmailBrowserAutomator({ gmailPoller: this.poller });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'UP',
          service: 'gmail-observer',
          isRunning: this.poller.isRunning,
          lastPollAt: this.poller.lastPollAt,
          observedCount: this.poller.observedCount
        }));
        return;
      }

      // GET /oauth/url
      if (pathname === '/oauth/url') {
        const clientId = process.env.GMAIL_CLIENT_ID || 'dummy_client_id';
        const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:6003/oauth/callback';
        const scope = encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly');
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authUrl }));
        return;
      }

      // GET /api/browser/status
      if (pathname === '/api/browser/status') {
        // Auto-ensure connection if currently idle/standby
        if (this.automator.mode === 'STANDBY' && !this.automator.isEnsuring) {
          this.automator.autoEnsureConnection().catch(() => {});
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(this.automator.getStatus()));
        return;
      }

      // POST /api/browser/auto-ensure
      if (pathname === '/api/browser/auto-ensure' && method === 'POST') {
        try {
          const result = await this.automator.autoEnsureConnection();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // POST /api/browser/launch-login
      if (pathname === '/api/browser/launch-login' && req.method === 'POST') {
        try {
          const result = this.automator.launchLoginWindow();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // POST /api/sweep (Active sweep trigger during 30-second verification window)
      if (pathname === '/api/sweep' && req.method === 'POST') {
        try {
          await this.automator.pollInboxEmails();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ swept: true, source: 'GMAIL', count: this.automator.emailsObserved }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // POST /process-email (Direct email ingestion / test injection)
      if (pathname === '/process-email' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const emailData = JSON.parse(body);
            const result = await this.poller.processEmail(emailData);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Gmail Observer Route Not Found');
    });
  }
}
