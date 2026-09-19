import { HttpServer } from '../server.js';
import { toPaise, toRupeesString } from '@youpi/common';
import { isTerminalStatus, toPublicOutcome } from '@youpi/core';

/**
 * Registers merchant-facing payment routes.
 * @param {HttpServer} server
 * @param {{
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   queueEngine: import('@youpi/core').QueueEngine,
 *   timingEngine: import('@youpi/core').TimingEngine,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   checkoutBaseUrl: string
 * }} ctx
 */
export function registerPaymentRoutes(server, ctx) {
  // POST /api/v1/payments
  server.post('/api/v1/payments', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;

    // Resolve merchant (default to first/demo merchant if none passed in header)
    const merchantId = req.headers['x-merchant-id'] || body.merchantId;
    let merchant;
    if (merchantId) {
      merchant = ctx.merchantRepo.findById(merchantId);
    } else {
      const merchants = ctx.merchantRepo.findAll();
      merchant = merchants[0];
    }

    if (!merchant) {
      HttpServer.json(res, 400, { error: 'Merchant not found or not configured.' });
      return;
    }

    if (!body.orderId || !body.amount) {
      HttpServer.json(res, 400, { error: 'Missing required fields: orderId and amount.' });
      return;
    }

    // Check idempotency: If payment already exists for this order, return existing
    const existing = ctx.sessionRepo.findByOrderId(merchant.id, body.orderId);
    if (existing) {
      HttpServer.json(res, 200, {
        paymentId: existing.id,
        orderId: existing.orderId,
        amount: toRupeesString(existing.amountPaise),
        amountPaise: existing.amountPaise.toString(),
        currency: existing.currency,
        status: existing.status,
        checkoutUrl: `${ctx.checkoutBaseUrl}/checkout/${existing.id}`
      });
      return;
    }

    let amountPaise;
    try {
      amountPaise = toPaise(body.amount);
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }

    const isCounterPayment = body.method === 'CASH_COUNTER' || body.method === 'CARD_COUNTER';

    let receivingAccountId = null;
    let receivingAccountSnapshot = null;
    if (!isCounterPayment) {
      // Resolve active receiving account for UPI
      const receivingAccount = ctx.accountRepo.findActiveForMerchant(merchant.id);
      if (!receivingAccount) {
        HttpServer.json(res, 500, { error: 'No active UPI receiving account configured for merchant.' });
        return;
      }
      receivingAccountId = receivingAccount.id;
      receivingAccountSnapshot = {
        id: receivingAccount.id,
        upiId: receivingAccount.upiId,
        payeeName: receivingAccount.payeeName,
        isMerchantEnabled: receivingAccount.isMerchantEnabled
      };
    }

    // Resolve customer if provided (optional pre-existing customer)
    let customerId = body.customerId || null;
    if (!customerId && (body.customer?.mobileNumber || body.customer?.phoneNumber || body.customer?.email) && ctx.customerRepo) {
      const ident = body.customer.email || body.customer.mobileNumber || body.customer.phoneNumber;
      const existingCust = ctx.customerRepo.findByIdentifier(ident);
      if (existingCust) {
        customerId = existingCust.id;
      }
    }

    // Invariant: Do NOT start payment session timer until customer is authenticated/logged in!
    // Customer sign in or sign up in the checkout portal is mandatory before slot activation or timer start.
    const shouldActivateNow = isCounterPayment || Boolean(body.autoActivate);
    const initialStatus = isCounterPayment ? 'ACTIVE' : 'INITIATED';

    const sessionMetadata = {
      ...(body.metadata || {}),
      ...(receivingAccountSnapshot ? { receivingAccountSnapshot } : {})
    };

    // Create session in DB
    const session = ctx.sessionRepo.create({
      merchantId: merchant.id,
      customerId,
      receivingAccountId,
      orderId: body.orderId,
      amountPaise,
      currency: body.currency || 'INR',
      method: body.method || 'UPI',
      status: initialStatus,
      returnUrl: body.returnUrl || null,
      idempotencyKey: idempotencyKey || null,
      metadata: sessionMetadata
    });

    // Enqueue or Activate slot via QueueEngine only when authenticated or pre-bound
    let queueResult = { status: initialStatus, queuePosition: 0, expiresAt: null };
    if (!isCounterPayment && receivingAccountId && shouldActivateNow) {
      queueResult = ctx.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

      // If activated immediately, start Timer 1 (5 minutes)
      if (queueResult.expiresAt) {
        ctx.timingEngine.startActiveTimer(session.id, queueResult.expiresAt);
      }
    }

    HttpServer.json(res, 201, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(amountPaise),
      amountPaise: amountPaise.toString(),
      currency: session.currency,
      status: queueResult.status,
      queuePosition: queueResult.queuePosition,
      checkoutUrl: `${ctx.checkoutBaseUrl}/checkout/${session.id}`
    });
  });

  // GET /api/v1/payments/:id
  server.get('/api/v1/payments/:id', async (req, res, params) => {
    const session = ctx.sessionRepo.findById(params.id);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${params.id}` });
      return;
    }

    const publicStatus = isTerminalStatus(session.status)
      ? toPublicOutcome(session.status)
      : session.status;

    HttpServer.json(res, 200, {
      paymentId: session.id,
      orderId: session.orderId,
      amount: toRupeesString(session.amountPaise),
      amountPaise: session.amountPaise.toString(),
      currency: session.currency,
      status: publicStatus,
      internalStatus: session.status,
      method: session.method,
      verificationLevel: session.verificationLevel || 0,
      verificationSources: session.verificationSources || [],
      verificationTag: session.verificationTag || 'UNVERIFIED',
      completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      returnUrl: session.returnUrl,
      metadata: session.metadata
    });
  });
}
