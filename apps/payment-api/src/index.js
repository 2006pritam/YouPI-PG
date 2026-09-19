import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}
import {
  getDatabase,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine
} from '@youpi/core';
import { HttpServer } from './server.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';

export function createPaymentApp(customDb = null) {
  const db = customDb || getDatabase();
  const { defaultMerchant } = runMigrations(db);

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);

  const eventEmitter = new EventEmitter();

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs: Number(process.env.PAYMENT_ACTIVE_WINDOW_MS || 300000),
    processingDurationMs: Number(process.env.PAYMENT_PROCESSING_WINDOW_MS || 30000)
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    auditRepo
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const server = new HttpServer();
  const checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';

  // BULLETPROOF QUEUE PROMOTION HANDLER
  function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  // When a payment succeeds, fails, expires, or cancels: dispatch webhook & promote next queued customer
  eventEmitter.on('PAYMENT.SUCCESS', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FAILED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.EXPIRED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.CANCELLED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  // Active 30-Second Verification Polling Orchestrator (Triple Verification Standard):
  // Concurrently sweeps Gmail, Google Messages SMS, and Android Observer every 1.5s
  // Continues polling for remaining sources until Level 3 (Triple Verification) is reached or 30s window finishes!
  const activeSweepTimers = new Set();

  eventEmitter.on('SESSION.PROCESSING', (data) => {
    const sessionId = data.sessionId;
    let sweepCount = 0;
    const maxSweeps = 20; // 20 sweeps * 1.5s = 30 seconds

    const sweepTimer = setInterval(async () => {
      try {
        sweepCount++;
        const current = sessionRepo.findById(sessionId);

        // Stop polling if session is terminal failed/expired/cancelled, or reached full Triple Verification (level >= 3), or exceeded 30s
        const isCompleteOrCancelled = !current ||
          current.status === PaymentStatus.FAILED ||
          current.status === PaymentStatus.EXPIRED ||
          current.status === PaymentStatus.CANCELLED ||
          (current.verificationLevel >= 3) ||
          sweepCount >= maxSweeps;

        if (isCompleteOrCancelled) {
          clearInterval(sweepTimer);
          activeSweepTimers.delete(sweepTimer);
          return;
        }

        // Sweep 1: Google Messages Web SMS
        try {
          const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
          fetch(`http://localhost:${smsPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 2: Gmail Inbox
        try {
          const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
          fetch(`http://localhost:${gmailPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 3: Check pending/unattributed Android push notifications in DB
        try {
          const unattributed = obsRepo.findUnattributed(current.receivingAccountId);
          for (const obs of unattributed) {
            attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          }
        } catch {}
      } catch {
        clearInterval(sweepTimer);
        activeSweepTimers.delete(sweepTimer);
      }
    }, 1500);

    if (sweepTimer.unref) sweepTimer.unref();
    activeSweepTimers.add(sweepTimer);
  });

  // Continuous 1-second background queue sync and auto-expiry daemon
  const queueSyncDaemon = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();

      // Sweep expired ACTIVE sessions
      const expiredActive = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `, [nowIso]);

      for (const row of expiredActive) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Sweep failed PROCESSING sessions
      const failedProc = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'PROCESSING' AND processing_expires_at <= ?
      `, [nowIso]);

      for (const row of failedProc) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.FAILED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Scan for vacant receiving accounts that have waiting queued sessions
      const vacantAccounts = db.query(`
        SELECT id FROM payment_receiving_accounts
        WHERE is_active = 1 AND (is_slot_busy = 0 OR current_active_session_id IS NULL)
      `);

      for (const acc of vacantAccounts) {
        handleSlotFreedAndPromote(acc.id);
      }
    } catch {}
  }, 1000);

  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  // Execute crash recovery on boot
  const recoveryStats = recoveryEngine.recover();

  // Health check route
  server.get('/health', (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  });

  const context = {
    db,
    merchantRepo,
    accountRepo,
    customerRepo,
    customerSessionRepo,
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    queueEngine,
    timingEngine,
    attributionEngine,
    recoveryEngine,
    eventEmitter,
    defaultMerchant,
    checkoutBaseUrl
  };

  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);

  function destroy() {
    clearInterval(queueSyncDaemon);
    for (const timer of activeSweepTimers) {
      clearInterval(timer);
    }
    activeSweepTimers.clear();
    timingEngine.destroy();
  }

  return {
    server,
    context,
    destroy,
    rawServer: server.createServer()
  };
}

export function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);
  const app = createPaymentApp(customDb);

  return new Promise(resolve => {
    const instance = app.rawServer.listen(finalPort, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: () => new Promise(cb => {
          app.destroy();
          instance.close(cb);
        })
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
