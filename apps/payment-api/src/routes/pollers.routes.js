import { HttpServer } from '../server.js';
import { ObservationNormalizer } from '@youpi/core';
import { toRupeesString } from '@youpi/common';

/**
 * Registers observation intake routes for automated observers (Gmail / SMS).
 * Android observer layer is completely decommissioned.
 * @param {HttpServer} server
 * @param {{
 *   attributionEngine: import('@youpi/core').AttributionEngine,
 *   db: import('@youpi/db').Database,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   sessionRepo?: import('@youpi/db').PaymentSessionRepository
 * }} ctx
 */
export function registerPollerRoutes(server, ctx) {
  // GET /api/v1/pollers/active-window (Enables deep intelligent DOM scanning for active amounts and dual-layer verification)
  server.get('/api/v1/pollers/active-window', async (req, res) => {
    const activeSessions = ctx.db.query(`
      SELECT id, order_id, receiving_account_id, amount_paise, status, verification_level, expires_at, processing_expires_at, completed_at
      FROM payment_sessions
      WHERE status IN ('ACTIVE', 'PROCESSING')
         OR (status = 'SUCCESS' AND verification_level < 2 AND completed_at >= datetime('now', '-60 seconds'))
      ORDER BY created_at DESC
    `);

    const sessions = activeSessions.map(s => ({
      id: s.id,
      orderId: s.order_id,
      receivingAccountId: s.receiving_account_id,
      amount: toRupeesString(s.amount_paise),
      amountPaise: Number(s.amount_paise),
      status: s.status,
      verificationLevel: s.verification_level || 0,
      expiresAt: s.expires_at,
      processingExpiresAt: s.processing_expires_at
    }));

    HttpServer.json(res, 200, {
      hasActivePayment: sessions.length > 0,
      sessions
    });
  });

  // POST /api/v1/pollers/events (Universal Observation Ingest for Gmail / SMS 2-Layer Observers)
  server.post('/api/v1/pollers/events', async (req, res) => {
    const body = await HttpServer.parseBody(req);

    if (!body.receivingAccountId || !body.source) {
      HttpServer.json(res, 400, { error: 'Missing required fields: receivingAccountId and source.' });
      return;
    }

    try {
      const normalized = ObservationNormalizer.normalize({
        source: body.source,
        receivingAccountId: body.receivingAccountId,
        rawPayload: body.rawPayload || body,
        amountPaise: body.amountPaise,
        amount: body.amount,
        observedAt: body.observedAt ? new Date(body.observedAt) : new Date(),
        senderVpa: body.senderVpa,
        bankReferenceNumber: body.bankReferenceNumber || body.utr
      });

      const result = ctx.attributionEngine.processObservation(normalized);

      // If attributed, broadcast SSE update to checkout
      if (result.attributed && result.paymentSessionId) {
        if (result.wasActive) {
          // Flip customer screen immediately to 30-second verification radar
          server.broadcastSse(result.paymentSessionId, 'status_change', {
            status: 'PROCESSING',
            processingExpiresAt: new Date(Date.now() + 30000).toISOString()
          });
          // After brief 3.5-second verification period, finalize to SUCCESS and redirect
          setTimeout(() => {
            server.broadcastSse(result.paymentSessionId, 'status_change', {
              status: result.outcomeStatus
            });
          }, 3500);
        } else {
          server.broadcastSse(result.paymentSessionId, 'status_change', {
            status: result.outcomeStatus
          });
        }
      }

      HttpServer.json(res, 200, {
        accepted: true,
        observationId: result.observationId,
        attribution: result
      });
    } catch (err) {
      console.error('[Poller Ingest Error]:', err.message);
      HttpServer.json(res, 400, { error: err.message });
    }
  });
}
