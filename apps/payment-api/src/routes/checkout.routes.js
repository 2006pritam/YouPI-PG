import { HttpServer } from '../server.js';
import { toRupeesString, buildUpiUri, PaymentStatus, PaymentMethod, UPI_PROVIDERS } from '@youpi/common';

/**
 * Registers customer checkout portal routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine
 * }} ctx
 */
export function registerCheckoutRoutes(server, ctx) {
  // GET /api/v1/checkout/:id/state
  server.get('/api/v1/checkout/:id/state', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Checkout session not found: ${params.id}` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const snapshot = session.metadata?.receivingAccountSnapshot;
    let receivingAccount = session.receivingAccountId
      ? ctx.accountRepo.findById(session.receivingAccountId)
      : null;

    if (!receivingAccount && snapshot?.id) {
      receivingAccount = ctx.accountRepo.findById(snapshot.id);
    }
    if (!receivingAccount && session.method === 'UPI') {
      receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
    }

    const payeeVpa = receivingAccount?.upiId || snapshot?.upiId || null;
    const payeeName = receivingAccount?.payeeName || snapshot?.payeeName || merchant?.businessName || 'Merchant Store';
    const isMerchantEnabled = receivingAccount
      ? Boolean(receivingAccount.isMerchantEnabled)
      : (snapshot?.isMerchantEnabled !== undefined ? Boolean(snapshot.isMerchantEnabled) : true);
    const upiMode = isMerchantEnabled ? 'MERCHANT' : 'NON_MERCHANT';

    let timeRemainingSeconds = 0;
    const now = Date.now();

    if (session.status === PaymentStatus.ACTIVE && session.expiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.expiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.PROCESSING && session.processingExpiresAt) {
      timeRemainingSeconds = Math.max(0, Math.ceil((session.processingExpiresAt.getTime() - now) / 1000));
    } else if (session.status === PaymentStatus.QUEUED) {
      timeRemainingSeconds = ctx.queueEngine.calculateEstimatedWaitSeconds(
        session.receivingAccountId,
        session.queuePosition
      );
    }

    let upiUri = null;
    if (session.status === PaymentStatus.ACTIVE && payeeVpa) {
      try {
        upiUri = buildUpiUri({
          payeeVpa,
          payeeName,
          amountPaise: session.amountPaise,
          transactionRef: session.orderId,
          currency: session.currency || 'INR'
        });
      } catch {
        upiUri = null;
      }
    }

    const branding = {
      appName: 'YOUPI PG',
      primaryColor: '#2563eb',
      logoUrl: null,
      counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
      ...(merchant?.branding || {})
    };

    const supportEmails = branding.supportEmails || (merchant?.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = branding.supportMobiles || (merchant?.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = branding.privacyPolicyUrl || null;
    branding.supportEmails = supportEmails;
    branding.supportMobiles = supportMobiles;
    branding.privacyPolicyUrl = privacyPolicyUrl;

    const enabledMethods = branding.enabledPaymentMethods || ['UPI', 'CASH_COUNTER', 'CARD_COUNTER'];

    let customer = null;
    if (session.customerId && ctx.customerRepo) {
      const c = ctx.customerRepo.findById(session.customerId);
      if (c) {
        customer = {
          id: c.id,
          name: c.name,
          email: c.email,
          mobileNumber: c.mobileNumber,
          fullName: c.name,
          phoneNumber: c.mobileNumber
        };
      }
    }

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      merchantName: merchant?.businessName || 'Merchant',
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: session.status,
      method: session.method,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      enabledMethods,
      customer,
      queuePosition: session.queuePosition || 0,
      timeRemainingSeconds,
      upiUri,
      payeeVpa,
      payeeName,
      isMerchantEnabled,
      upiMode,
      receivingAccountId: receivingAccount?.id || snapshot?.id || null,
      providers: UPI_PROVIDERS,
      canClickPaymentDone: session.status === PaymentStatus.ACTIVE,
      returnUrl: session.returnUrl,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      branding
    });
  });

  // POST /api/v1/checkout/:id/bind-customer
  server.post('/api/v1/checkout/:id/bind-customer', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const token = body.token || body.sessionToken || ((req.headers['authorization'] || '').startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
    const { customerId } = body;

    let customer = null;
    if (token && ctx.customerSessionRepo) {
      const authContext = ctx.customerSessionRepo.findByToken(token);
      if (!authContext) {
        HttpServer.json(res, 401, { error: 'Invalid or expired customer session token.' });
        return;
      }
      customer = authContext.customer;
    } else if (customerId && ctx.customerRepo) {
      customer = ctx.customerRepo.findById(customerId);
    }

    if (!customer) {
      HttpServer.json(res, 400, { error: 'A valid customer session token or customerId is required.' });
      return;
    }

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    // INVARIANT: Payment session identity is IMMUTABLE once bound!
    // Cannot mutate or hijack an active session to another customer identity.
    if (session.customerId && session.customerId !== customer.id) {
      HttpServer.json(res, 409, {
        error: 'Payment session is already bound to another customer identity and cannot be mutated or reassigned.'
      });
      return;
    }

    // If already bound to this exact customer, return current state idempotently
    if (session.customerId === customer.id) {
      HttpServer.json(res, 200, {
        success: true,
        status: session.status,
        queuePosition: session.queuePosition || 0,
        expiresAt: session.expiresAt,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          mobileNumber: customer.mobileNumber,
          fullName: customer.name,
          phoneNumber: customer.mobileNumber
        }
      });
      return;
    }

    // Bind customer to payment session
    ctx.db.execute(`
      UPDATE payment_sessions
      SET customer_id = ?, updated_at = ?
      WHERE id = ?
    `, [customer.id, new Date().toISOString(), params.id]);

    // INVARIANT: When customer logs in or signs up, activate session and start 5-minute timer NOW!
    let queueResult = { status: session.status, queuePosition: session.queuePosition, expiresAt: session.expiresAt };
    if (session.status === PaymentStatus.INITIATED && session.receivingAccountId) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, session.receivingAccountId);
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
      server.broadcastSse(session.id, 'status_change', {
        status: queueResult.status,
        queuePosition: queueResult.queuePosition,
        expiresAt: queueResult.expiresAt
      });
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'CUSTOMER_AUTHENTICATED_AND_BOUND',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber, sessionStatus: queueResult.status }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      expiresAt: queueResult.expiresAt,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        fullName: customer.name,
        phoneNumber: customer.mobileNumber
      }
    });
  });

  // POST /api/v1/checkout/:id/payment-done
  server.post('/api/v1/checkout/:id/payment-done', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (session.status === PaymentStatus.PROCESSING) {
      // Idempotent
      HttpServer.json(res, 200, {
        status: PaymentStatus.PROCESSING,
        message: 'Already in verification processing.'
      });
      return;
    }

    if (session.status !== PaymentStatus.ACTIVE) {
      HttpServer.json(res, 400, {
        error: `Cannot start verification: session is in status '${session.status}', must be 'ACTIVE'.`
      });
      return;
    }

    const updated = ctx.timingEngine.handlePaymentDone(params.id);

    // Broadcast SSE update
    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });

    HttpServer.json(res, 200, {
      paymentId: updated.id,
      status: PaymentStatus.PROCESSING,
      processingExpiresAt: updated.processingExpiresAt
    });
  });

  // POST /api/v1/checkout/:id/cancel
  server.post('/api/v1/checkout/:id/cancel', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const updated = ctx.timingEngine.handleCancel(params.id);

    server.broadcastSse(params.id, 'status_change', {
      status: PaymentStatus.CANCELLED
    });

    HttpServer.json(res, 200, {
      paymentId: updated.id,
      status: PaymentStatus.CANCELLED
    });
  });

  // POST /api/v1/checkout/:id/select-method (Switches payment method e.g. Cash/Card at Counter or UPI)
  server.post('/api/v1/checkout/:id/select-method', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { method } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      HttpServer.json(res, 400, { error: `Cannot switch payment method for terminal session in status '${session.status}'` });
      return;
    }

    const validMethods = [PaymentMethod.UPI, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    if (!validMethods.includes(method)) {
      HttpServer.json(res, 400, { error: `Invalid payment method '${method}'. Allowed: ${validMethods.join(', ')}` });
      return;
    }

    const merchant = ctx.merchantRepo.findById(session.merchantId);
    const branding = merchant?.branding || {};
    const enabled = branding.enabledPaymentMethods || ['UPI', 'CASH_COUNTER', 'CARD_COUNTER'];
    if (!enabled.includes(method)) {
      HttpServer.json(res, 400, { error: `Payment method '${method}' is disabled by the merchant.` });
      return;
    }

    const previousMethod = session.method;
    const isCounter = method === PaymentMethod.CASH_COUNTER || method === PaymentMethod.CARD_COUNTER;
    const wasCounter = previousMethod === PaymentMethod.CASH_COUNTER || previousMethod === PaymentMethod.CARD_COUNTER;
    const nowIso = new Date().toISOString();

    let updates = `method = ?, updated_at = ?`;
    let updateParams = [method, nowIso];

    // If switching from digital UPI to counter payment:
    // Counter payments do not block the digital UPI queue slot!
    let oldReceivingAccountId = null;
    if (isCounter && session.receivingAccountId) {
      oldReceivingAccountId = session.receivingAccountId;
      updates += `, receiving_account_id = NULL, status = 'ACTIVE', queue_position = 0`;
      session.receivingAccountId = null;
      session.status = PaymentStatus.ACTIVE;
      session.queuePosition = 0;
    } else if (!isCounter && wasCounter) {
      // Switching back to UPI: re-resolve active receiving account and enqueue/activate
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(session.merchantId);
      if (receivingAccount) {
        const queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccount.id);
        updates += `, receiving_account_id = ?, status = ?, queue_position = ?, expires_at = ?`;
        updateParams.push(
          receivingAccount.id,
          queueResult.status,
          queueResult.queuePosition,
          queueResult.expiresAt ? queueResult.expiresAt.toISOString() : null
        );
        session.receivingAccountId = receivingAccount.id;
        session.status = queueResult.status;
        session.queuePosition = queueResult.queuePosition;
        session.expiresAt = queueResult.expiresAt;
      }
    }

    updateParams.push(session.id);
    ctx.db.execute(`UPDATE payment_sessions SET ${updates} WHERE id = ?`, updateParams);
    session.method = method;

    // If slot was released on the receiving account, update receiving account and promote waiting queued sessions!
    if (oldReceivingAccountId) {
      ctx.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
        WHERE id = ? AND current_active_session_id = ?
      `, [nowIso, oldReceivingAccountId, session.id]);

      const promoted = ctx.queueEngine.promoteNext(oldReceivingAccountId);
      if (promoted) {
        if (promoted.expiresAt && ctx.timingEngine) {
          ctx.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
        }
        server.broadcastSse(promoted.id, 'status_change', {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: promoted.expiresAt
        });
        server.broadcastSse(`queue_${oldReceivingAccountId}`, 'queue_update', {
          promotedId: promoted.id
        });
      }
    }

    // Broadcast SSE update to customer session channel
    server.broadcastSse(session.id, 'status_change', {
      status: session.status,
      method: session.method,
      queuePosition: session.queuePosition || 0
    });

    // Broadcast live event to merchant dashboard counter desk
    server.broadcastSse('admin_counter_events', 'counter_payment_requested', {
      paymentId: session.id,
      orderId: session.orderId,
      amountPaise: session.amountPaise.toString(),
      method: session.method,
      status: session.status,
      createdAt: session.createdAt
    });

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_METHOD_SWITCHED',
        actorType: 'CUSTOMER',
        details: { from: previousMethod, to: method }
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.METHOD_SWITCHED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        fromMethod: previousMethod,
        toMethod: method
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      method: session.method,
      status: session.status,
      counterInstructions: branding.counterInstructions || 'Please visit the billing counter and present this screen to the cashier.'
    });
  });

  // POST /api/v1/checkout/:id/expire (Explicit Client Expiry Trigger)
  server.post('/api/v1/checkout/:id/expire', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (session.status === PaymentStatus.ACTIVE) {
      ctx.timingEngine.handleActiveTimerExpiration(session.id);
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
    }

    HttpServer.json(res, 200, {
      success: true,
      paymentId: session.id,
      status: PaymentStatus.EXPIRED
    });
  });

  // POST /api/v1/checkout/:id/trigger-hook (Merchant Action & Telemetry Trigger)
  server.post('/api/v1/checkout/:id/trigger-hook', async (req, res, params) => {
    const body = await HttpServer.parseBody(req);
    const { action, details } = body;

    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: `HOOK_${action || 'USER_ACTION'}`,
        actorType: 'CUSTOMER',
        details: details || {}
      });
    }

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.ACTION_TRIGGERED', {
        paymentId: session.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        action: action || 'ACTION',
        details: details || {}
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      action: action || 'ACTION',
      timestamp: new Date().toISOString()
    });
  });

  // GET /api/v1/checkout/:id/stream (SSE)
  server.get('/api/v1/checkout/:id/stream', async (req, res, params) => {
    server.initSse(params.id, res);
  });
}
