import { PaymentObserverClient } from '@youpi/observer-sdk';
import { BankEmailParser } from './parser.js';

export class GmailPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.receivingAccountId = options.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 5000);
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
  }

  /**
   * Ingests an email directly (e.g. from webhook, push notification, or manual poll).
   * @param {{ subject: string, body: string, date?: string | Date, from?: string }} email
   */
  async processEmail(email) {
    const parsed = BankEmailParser.parse(email);
    if (!parsed) return null;

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: this.receivingAccountId,
        amountPaise: parsed.amountPaise,
        amount: parsed.amount,
        observedAt: parsed.observedAt,
        bankReferenceNumber: parsed.bankReferenceNumber,
        senderVpa: parsed.senderVpa,
        rawPayload: {
          subject: email.subject,
          snippet: parsed.rawSnippet,
          from: email.from
        }
      });

      this.observedCount++;
      return result;
    } catch (err) {
      console.error('[Gmail Observer] Submission failed:', err.message);
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Gmail Observer] Poller started (interval: ${this.pollIntervalMs}ms)`);

    this.timer = setInterval(() => {
      this.pollCycle();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[Gmail Observer] Poller stopped.');
  }

  async pollCycle() {
    this.lastPollAt = new Date();
    // In production, uses Gmail API `messages.list({ q: 'is:unread' })` with OAuth tokens.
  }
}
