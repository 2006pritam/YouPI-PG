import { HttpServer } from '../server.js';
import { PaymentStatus, PaymentMethod, AuditActorType, isValidVpa } from '@youpi/common';

/**
 * Registers merchant admin dashboard routes.
 * @param {HttpServer} server
 * @param {{
 *   db: import('@youpi/db').Database,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
 *   merchantRepo: import('@youpi/db').MerchantRepository,
 *   auditRepo: import('@youpi/db').AuditLogRepository,
 *   queueEngine: import('@youpi/core').QueueEngine
 * }} ctx
 */
export function registerAdminRoutes(server, ctx) {
  // GET /api/v1/admin/queue
  server.get('/api/v1/admin/queue', async (req, res) => {
    const merchantId = req.query.merchantId || '00000000-0000-0000-0000-000000000001';
    const account = ctx.accountRepo.findActiveForMerchant(merchantId);

    if (!account) {
      HttpServer.json(res, 200, { active: null, queue: [] });
      return;
    }

    const currentActive = ctx.sessionRepo.findCurrentActiveOrProcessing(account.id);
    const queuedSessions = ctx.sessionRepo.findQueuedSessions(account.id);

    HttpServer.json(res, 200, {
      receivingAccount: {
        id: account.id,
        upiId: account.upiId,
        payeeName: account.payeeName,
        isSlotBusy: account.isSlotBusy
      },
      currentSlot: currentActive ? {
        id: currentActive.id,
        orderId: currentActive.orderId,
        amountPaise: currentActive.amountPaise.toString(),
        status: currentActive.status,
        expiresAt: currentActive.expiresAt,
        processingExpiresAt: currentActive.processingExpiresAt
      } : null,
      queue: queuedSessions.map(s => ({
        id: s.id,
        orderId: s.orderId,
        amountPaise: s.amountPaise.toString(),
        queuePosition: s.queuePosition,
        createdAt: s.createdAt
      }))
    });
  });

  // GET /api/v1/admin/observers
  server.get('/api/v1/admin/observers', async (req, res) => {
    const devices = ctx.db.query('SELECT * FROM android_devices ORDER BY created_at DESC');
    const now = Date.now();

    const androidHealth = devices.map(d => {
      const lastSeen = d.last_heartbeat_at ? new Date(d.last_heartbeat_at).getTime() : 0;
      const isConnected = (now - lastSeen) < 180000; // Connected if heartbeat within 3 mins
      return {
        id: d.id,
        name: d.device_name,
        model: d.device_model,
        status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
        lastSeenAt: d.last_heartbeat_at,
        lastObservationAt: d.last_observation_at
      };
    });

    // Query live Google Messages browser automator status
    let smsStatus = { status: 'STANDBY', isPaired: false, messagesObserved: 0 };
    try {
      const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
      const smsRes = await fetch(`http://localhost:${smsPort}/api/browser/status`, { signal: AbortSignal.timeout(1500) });
      if (smsRes.ok) {
        smsStatus = await smsRes.json();
      }
    } catch {}

    // Query live Gmail browser automator status
    let gmailStatus = { status: 'STANDBY', isLoggedIn: false, emailsObserved: 0 };
    try {
      const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
      const gmailRes = await fetch(`http://localhost:${gmailPort}/api/browser/status`, { signal: AbortSignal.timeout(1500) });
      if (gmailRes.ok) {
        gmailStatus = await gmailRes.json();
      }
    } catch {}

    HttpServer.json(res, 200, {
      gmail: {
        status: gmailStatus.status || (gmailStatus.isLoggedIn ? 'CONNECTED' : 'STANDBY'),
        isLoggedIn: Boolean(gmailStatus.isLoggedIn),
        emailsObserved: gmailStatus.emailsObserved || 0,
        lastCheckedAt: gmailStatus.lastCheckedAt || null
      },
      android: {
        devices: androidHealth,
        totalDevices: devices.length
      },
      sms: {
        status: smsStatus.status || (smsStatus.isPaired ? 'CONNECTED' : 'STANDBY'),
        isPaired: Boolean(smsStatus.isPaired),
        messagesObserved: smsStatus.messagesObserved || 0,
        lastSeenAt: smsStatus.lastSeenAt || null
      }
    });
  });

  // GET /api/v1/admin/payments
  server.get('/api/v1/admin/payments', async (req, res) => {
    const merchantId = req.query.merchantId || '00000000-0000-0000-0000-000000000001';
    const limit = parseInt(req.query.limit || '50', 10);
    const payments = ctx.sessionRepo.findByMerchantId(merchantId, limit);

    HttpServer.json(res, 200, {
      payments: payments.map(p => ({
        id: p.id,
        orderId: p.orderId,
        amountPaise: p.amountPaise.toString(),
        currency: p.currency,
        method: p.method,
        status: p.status,
        verificationLevel: p.verificationLevel || 0,
        verificationSources: p.verificationSources || [],
        verificationTag: p.verificationTag || 'UNVERIFIED',
        createdAt: p.createdAt,
        completedAt: p.completedAt
      }))
    });
  });

  // GET /api/v1/admin/tickets
  server.get('/api/v1/admin/tickets', async (req, res) => {
    const merchantId = req.query.merchantId || '00000000-0000-0000-0000-000000000001';
    if (!ctx.ticketRepo) {
      HttpServer.json(res, 200, { tickets: [] });
      return;
    }
    const tickets = ctx.ticketRepo.findTicketsByMerchant(merchantId);
    HttpServer.json(res, 200, { tickets });
  });

  // POST /api/v1/admin/tickets/:id/resolve
  server.post('/api/v1/admin/tickets/:id/resolve', async (req, res, params) => {
    if (!ctx.ticketRepo) {
      HttpServer.json(res, 404, { error: 'Ticket repo not configured' });
      return;
    }
    const ticket = ctx.ticketRepo.updateTicketStatus(params.id, 'RESOLVED');
    HttpServer.json(res, 200, { success: true, ticket });
  });

  // POST /api/v1/admin/counter-confirm
  server.post('/api/v1/admin/counter-confirm', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { paymentId, operatorId, method } = body;

    if (!paymentId || !operatorId) {
      HttpServer.json(res, 400, { error: 'paymentId and operatorId are required.' });
      return;
    }

    const session = ctx.sessionRepo.findById(paymentId);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${paymentId}` });
      return;
    }

    const updated = ctx.sessionRepo.transitionToTerminal(paymentId, PaymentStatus.SUCCESS);

    ctx.auditRepo.log({
      merchantId: session.merchantId,
      entityType: 'PAYMENT_SESSION',
      entityId: paymentId,
      action: 'COUNTER_MANUAL_PAYMENT_CONFIRMED',
      actorType: AuditActorType.ADMIN,
      actorId: operatorId,
      details: { method: method || PaymentMethod.CASH_COUNTER, operatorId }
    });

    server.broadcastSse(paymentId, 'status_change', {
      status: PaymentStatus.SUCCESS,
      method: method || PaymentMethod.CASH_COUNTER
    });

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.SUCCESS', {
        paymentId: updated.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        amountPaise: session.amountPaise
      });
    }

    HttpServer.json(res, 200, {
      confirmed: true,
      paymentId: updated.id,
      status: PaymentStatus.SUCCESS
    });
  });

  // POST /api/v1/admin/counter-decline (Declines/Rejects manual cash or card counter payment)
  server.post('/api/v1/admin/counter-decline', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { paymentId, operatorId, reason } = body;

    if (!paymentId || !operatorId) {
      HttpServer.json(res, 400, { error: 'paymentId and operatorId are required.' });
      return;
    }

    const session = ctx.sessionRepo.findById(paymentId);
    if (!session) {
      HttpServer.json(res, 404, { error: `Payment session not found: ${paymentId}` });
      return;
    }

    const updated = ctx.sessionRepo.transitionToTerminal(paymentId, PaymentStatus.FAILED);

    ctx.auditRepo.log({
      merchantId: session.merchantId,
      entityType: 'PAYMENT_SESSION',
      entityId: paymentId,
      action: 'COUNTER_MANUAL_PAYMENT_DECLINED',
      actorType: AuditActorType.ADMIN,
      actorId: operatorId,
      details: {
        method: session.method,
        operatorId,
        reason: reason || 'Declined by merchant counter operator'
      }
    });

    server.broadcastSse(paymentId, 'status_change', {
      status: PaymentStatus.FAILED,
      method: session.method,
      reason: reason || 'Declined by merchant counter operator'
    });

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.FAILED', {
        paymentId: updated.id,
        orderId: session.orderId,
        merchantId: session.merchantId,
        amountPaise: session.amountPaise,
        reason: reason || 'Counter payment declined'
      });
    }

    HttpServer.json(res, 200, {
      declined: true,
      paymentId: updated.id,
      status: PaymentStatus.FAILED,
      reason: reason || 'Counter payment declined'
    });
  });

  // GET /api/v1/admin/upi-settings
  server.get('/api/v1/admin/upi-settings', async (req, res) => {
    let merchant = req.query.merchantId ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    const account = merchant ? ctx.accountRepo.findActiveForMerchant(merchant.id) : null;
    const accounts = merchant ? ctx.accountRepo.findByMerchantId(merchant.id) : [];

    if (!account) {
      HttpServer.json(res, 200, {
        id: '',
        upiId: '',
        payeeName: '',
        isMerchantEnabled: true,
        isActive: false,
        accounts
      });
      return;
    }
    HttpServer.json(res, 200, {
      id: account.id,
      upiId: account.upiId,
      payeeName: account.payeeName,
      isMerchantEnabled: account.isMerchantEnabled,
      isActive: account.isActive,
      accounts
    });
  });

  // GET /api/v1/admin/upi-accounts (List all merchant VPAs)
  server.get('/api/v1/admin/upi-accounts', async (req, res) => {
    let merchant = req.query.merchantId ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    const accounts = ctx.accountRepo.findByMerchantId(merchant.id);
    HttpServer.json(res, 200, {
      accounts: accounts.map(a => ({
        id: a.id,
        merchantId: a.merchantId,
        upiId: a.upiId,
        payeeName: a.payeeName,
        isMerchantEnabled: a.isMerchantEnabled,
        isActive: a.isActive,
        isSlotBusy: a.isSlotBusy,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
      }))
    });
  });

  // POST /api/v1/admin/upi-accounts (Add a new VPA with Merchant/Non-Merchant option)
  server.post('/api/v1/admin/upi-accounts', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { upiId, payeeName, isMerchantEnabled, isActive } = body;
    let merchant = body.merchantId ? ctx.merchantRepo.findById(body.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    if (!upiId || !upiId.trim()) {
      HttpServer.json(res, 400, { error: 'UPI ID (VPA) is required.' });
      return;
    }

    if (!isValidVpa(upiId.trim())) {
      HttpServer.json(res, 400, { error: `Invalid UPI VPA format: "${upiId}". Expected: username@bank` });
      return;
    }

    const existingAccounts = ctx.accountRepo.findByMerchantId(merchant.id);
    const shouldActivate = isActive !== undefined ? Boolean(isActive) : (existingAccounts.length === 0);

    const account = ctx.accountRepo.create({
      merchantId: merchant.id,
      upiId: upiId.trim(),
      payeeName: payeeName?.trim() || merchant.businessName,
      isMerchantEnabled: isMerchantEnabled !== undefined ? Boolean(isMerchantEnabled) : true,
      isActive: shouldActivate
    });

    ctx.auditRepo.log({
      merchantId: merchant.id,
      entityType: 'PAYMENT_RECEIVING_ACCOUNT',
      entityId: account.id,
      action: 'RECEIVING_UPI_ADDED',
      actorType: AuditActorType.ADMIN,
      details: {
        upiId: account.upiId,
        payeeName: account.payeeName,
        isMerchantEnabled: account.isMerchantEnabled,
        isActive: account.isActive
      }
    });

    HttpServer.json(res, 201, {
      success: true,
      account
    });
  });

  // POST /api/v1/admin/upi-accounts/:id/activate (Atomically activate VPA, deactivating all others)
  server.post('/api/v1/admin/upi-accounts/:id/activate', async (req, res, params) => {
    const account = ctx.accountRepo.findById(params.id);
    if (!account) {
      HttpServer.json(res, 404, { error: `UPI Account not found: ${params.id}` });
      return;
    }

    const updated = ctx.accountRepo.activateAccount(account.merchantId, account.id);

    ctx.auditRepo.log({
      merchantId: account.merchantId,
      entityType: 'PAYMENT_RECEIVING_ACCOUNT',
      entityId: updated.id,
      action: 'RECEIVING_UPI_ACTIVATED',
      actorType: AuditActorType.ADMIN,
      details: {
        upiId: updated.upiId,
        payeeName: updated.payeeName,
        isMerchantEnabled: updated.isMerchantEnabled
      }
    });

    HttpServer.json(res, 200, {
      success: true,
      activeAccount: updated
    });
  });

  // POST /api/v1/admin/upi-accounts/:id/toggle (Toggle VPA active state)
  server.post('/api/v1/admin/upi-accounts/:id/toggle', async (req, res, params) => {
    const account = ctx.accountRepo.findById(params.id);
    if (!account) {
      HttpServer.json(res, 404, { error: `UPI Account not found: ${params.id}` });
      return;
    }

    let updated;
    if (account.isActive) {
      updated = ctx.accountRepo.deactivateAccount(account.merchantId, account.id);
    } else {
      updated = ctx.accountRepo.activateAccount(account.merchantId, account.id);
    }

    ctx.auditRepo.log({
      merchantId: account.merchantId,
      entityType: 'PAYMENT_RECEIVING_ACCOUNT',
      entityId: updated.id,
      action: updated.isActive ? 'RECEIVING_UPI_ACTIVATED' : 'RECEIVING_UPI_DEACTIVATED',
      actorType: AuditActorType.ADMIN,
      details: { upiId: updated.upiId, isActive: updated.isActive }
    });

    HttpServer.json(res, 200, {
      success: true,
      account: updated
    });
  });

  // DELETE /api/v1/admin/upi-accounts/:id (Delete VPA)
  server.delete('/api/v1/admin/upi-accounts/:id', async (req, res, params) => {
    const account = ctx.accountRepo.findById(params.id);
    if (!account) {
      HttpServer.json(res, 404, { error: `UPI Account not found: ${params.id}` });
      return;
    }

    try {
      ctx.accountRepo.deleteAccount(account.merchantId, account.id);
      ctx.auditRepo.log({
        merchantId: account.merchantId,
        entityType: 'PAYMENT_RECEIVING_ACCOUNT',
        entityId: account.id,
        action: 'RECEIVING_UPI_DELETED',
        actorType: AuditActorType.ADMIN,
        details: { upiId: account.upiId }
      });
      HttpServer.json(res, 200, { success: true, deletedId: account.id });
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
    }
  });

  // POST /api/v1/admin/upi-settings (Custom UPI ID addition & persistence)
  server.post('/api/v1/admin/upi-settings', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { upiId, payeeName, isMerchantEnabled } = body;
    let merchant = body.merchantId ? ctx.merchantRepo.findById(body.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    if (!upiId || !upiId.trim()) {
      HttpServer.json(res, 400, { error: 'UPI ID (VPA) is required.' });
      return;
    }

    if (!isValidVpa(upiId.trim())) {
      HttpServer.json(res, 400, { error: `Invalid UPI VPA format: "${upiId}". Expected format: username@bank` });
      return;
    }

    const isEnabled = isMerchantEnabled !== undefined ? Boolean(isMerchantEnabled) : true;
    const updatedAccount = ctx.accountRepo.upsertActiveForMerchant(
      merchant.id,
      upiId.trim(),
      payeeName?.trim() || merchant.businessName,
      isEnabled
    );

    ctx.auditRepo.log({
      merchantId: merchant.id,
      entityType: 'PAYMENT_RECEIVING_ACCOUNT',
      entityId: updatedAccount.id,
      action: 'RECEIVING_UPI_UPDATED',
      actorType: AuditActorType.ADMIN,
      details: {
        upiId: updatedAccount.upiId,
        payeeName: updatedAccount.payeeName,
        isMerchantEnabled: updatedAccount.isMerchantEnabled
      }
    });

    HttpServer.json(res, 200, {
      success: true,
      receivingAccount: {
        id: updatedAccount.id,
        upiId: updatedAccount.upiId,
        payeeName: updatedAccount.payeeName,
        isMerchantEnabled: updatedAccount.isMerchantEnabled,
        isActive: updatedAccount.isActive
      }
    });
  });

  // GET /api/v1/admin/all-settings (Unified Settings Read)
  server.get('/api/v1/admin/all-settings', async (req, res) => {
    let merchant = req.query.merchantId ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    const account = ctx.accountRepo.findActiveForMerchant(merchant.id);
    const branding = merchant.branding || {};
    const enabledPaymentMethods = branding.enabledPaymentMethods || [PaymentMethod.UPI, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    const supportEmails = branding.supportEmails || (merchant.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = branding.supportMobiles || (merchant.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = branding.privacyPolicyUrl || '';

    HttpServer.json(res, 200, {
      merchantId: merchant.id,
      businessName: merchant.businessName,
      upiId: account ? account.upiId : '',
      payeeName: account ? account.payeeName : merchant.businessName,
      webhookUrl: merchant.webhookUrl || '',
      webhookSecret: merchant.webhookSecret || '',
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      branding: {
        appName: branding.appName || 'YOUPI PG',
        primaryColor: branding.primaryColor || '#2563eb',
        logoUrl: branding.logoUrl || null,
        sidebarNotice: branding.sidebarNotice || 'Fast & Secure 256-Bit Encrypted Payments',
        footerGuarantee: branding.footerGuarantee || 'Secured by YOUPI PG 256-Bit Encryption',
        counterInstructions: branding.counterInstructions || 'Please visit the store billing counter and present this screen to the cashier.',
        enabledPaymentMethods,
        supportEmails,
        supportMobiles,
        privacyPolicyUrl
      }
    });
  });

  // POST /api/v1/admin/all-settings (Atomic Unified Settings Write)
  server.post('/api/v1/admin/all-settings', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    let merchant = body.merchantId ? ctx.merchantRepo.findById(body.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    // 1. Update UPI VPA if provided
    let account = ctx.accountRepo.findActiveForMerchant(merchant.id);
    if (body.upiId && body.upiId.trim()) {
      if (!isValidVpa(body.upiId.trim())) {
        HttpServer.json(res, 400, { error: `Invalid UPI VPA format: "${body.upiId}". Expected: username@bank` });
        return;
      }
      account = ctx.accountRepo.upsertActiveForMerchant(merchant.id, body.upiId.trim(), body.payeeName?.trim() || body.businessName?.trim() || merchant.businessName);
    }

    // 2. Non-Destructive Deep Merge for Branding & Merchant Properties
    const updates = {};
    if (body.businessName && body.businessName.trim()) {
      updates.businessName = body.businessName.trim();
    }
    if (body.webhookUrl !== undefined) {
      updates.webhookUrl = body.webhookUrl?.trim() || null;
    }
    if (body.webhookSecret !== undefined && body.webhookSecret.trim()) {
      updates.webhookSecret = body.webhookSecret.trim();
    }

    const currentBranding = merchant.branding || {};
    const inputBranding = body.branding || {};
    const mergedBranding = { ...currentBranding };

    if (inputBranding.appName !== undefined) mergedBranding.appName = inputBranding.appName.trim() || currentBranding.appName || 'YOUPI PG';
    if (inputBranding.logoUrl !== undefined) mergedBranding.logoUrl = inputBranding.logoUrl ? inputBranding.logoUrl.trim() : null;
    if (inputBranding.primaryColor !== undefined) mergedBranding.primaryColor = inputBranding.primaryColor.trim() || currentBranding.primaryColor || '#2563eb';
    if (inputBranding.sidebarNotice !== undefined) mergedBranding.sidebarNotice = inputBranding.sidebarNotice ? inputBranding.sidebarNotice.trim() : null;
    if (inputBranding.checkoutNotice !== undefined) mergedBranding.checkoutNotice = inputBranding.checkoutNotice ? inputBranding.checkoutNotice.trim() : null;
    if (inputBranding.footerGuarantee !== undefined) mergedBranding.footerGuarantee = inputBranding.footerGuarantee ? inputBranding.footerGuarantee.trim() : null;
    if (inputBranding.counterInstructions !== undefined) mergedBranding.counterInstructions = inputBranding.counterInstructions ? inputBranding.counterInstructions.trim() : null;

    if (body.enabledPaymentMethods && Array.isArray(body.enabledPaymentMethods)) {
      mergedBranding.enabledPaymentMethods = body.enabledPaymentMethods;
    } else if (inputBranding.enabledPaymentMethods && Array.isArray(inputBranding.enabledPaymentMethods)) {
      mergedBranding.enabledPaymentMethods = inputBranding.enabledPaymentMethods;
    }

    if (body.supportEmails !== undefined || inputBranding.supportEmails !== undefined) {
      const raw = body.supportEmails !== undefined ? body.supportEmails : inputBranding.supportEmails;
      mergedBranding.supportEmails = Array.isArray(raw)
        ? raw.map(s => String(s).trim()).filter(Boolean)
        : (typeof raw === 'string' ? raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean) : []);
    }
    if (body.supportMobiles !== undefined || inputBranding.supportMobiles !== undefined) {
      const raw = body.supportMobiles !== undefined ? body.supportMobiles : inputBranding.supportMobiles;
      mergedBranding.supportMobiles = Array.isArray(raw)
        ? raw.map(s => String(s).trim()).filter(Boolean)
        : (typeof raw === 'string' ? raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean) : []);
    }
    if (body.privacyPolicyUrl !== undefined || inputBranding.privacyPolicyUrl !== undefined) {
      const raw = body.privacyPolicyUrl !== undefined ? body.privacyPolicyUrl : inputBranding.privacyPolicyUrl;
      mergedBranding.privacyPolicyUrl = raw ? String(raw).trim() : null;
    }

    updates.branding = mergedBranding;

    const updated = ctx.merchantRepo.update(merchant.id, updates);

    ctx.auditRepo.log({
      merchantId: merchant.id,
      entityType: 'MERCHANT',
      entityId: merchant.id,
      action: 'ALL_SETTINGS_UPDATED_ATOMIC',
      actorType: AuditActorType.ADMIN,
      details: { businessName: updated.businessName, upiId: account?.upiId, branding: updated.branding }
    });

    HttpServer.json(res, 200, {
      success: true,
      merchantId: updated.id,
      businessName: updated.businessName,
      upiId: account ? account.upiId : '',
      payeeName: account ? account.payeeName : updated.businessName,
      webhookUrl: updated.webhookUrl || '',
      webhookSecret: updated.webhookSecret || '',
      supportEmails: updated.branding?.supportEmails || [],
      supportMobiles: updated.branding?.supportMobiles || [],
      privacyPolicyUrl: updated.branding?.privacyPolicyUrl || '',
      branding: updated.branding
    });
  });

  // GET /api/v1/admin/merchant-settings
  server.get('/api/v1/admin/merchant-settings', async (req, res) => {
    let merchant = req.query.merchantId ? ctx.merchantRepo.findById(req.query.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    const branding = merchant.branding || {};
    if (!branding.enabledPaymentMethods) {
      branding.enabledPaymentMethods = [PaymentMethod.UPI, PaymentMethod.CASH_COUNTER, PaymentMethod.CARD_COUNTER];
    }
    const supportEmails = branding.supportEmails || (merchant.contactEmail ? [merchant.contactEmail] : []);
    const supportMobiles = branding.supportMobiles || (merchant.contactPhone ? [merchant.contactPhone] : []);
    const privacyPolicyUrl = branding.privacyPolicyUrl || '';

    HttpServer.json(res, 200, {
      merchantId: merchant.id,
      businessName: merchant.businessName,
      contactEmail: merchant.contactEmail,
      contactPhone: merchant.contactPhone,
      webhookUrl: merchant.webhookUrl,
      webhookSecret: merchant.webhookSecret,
      supportEmails,
      supportMobiles,
      privacyPolicyUrl,
      branding: {
        ...branding,
        supportEmails,
        supportMobiles,
        privacyPolicyUrl
      }
    });
  });

  // POST /api/v1/admin/merchant-settings
  server.post('/api/v1/admin/merchant-settings', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    let merchant = body.merchantId ? ctx.merchantRepo.findById(body.merchantId) : null;
    if (!merchant) merchant = ctx.merchantRepo.findAll()[0];

    if (!merchant) {
      HttpServer.json(res, 404, { error: 'Merchant not found' });
      return;
    }

    const updates = {};
    if (body.businessName && body.businessName.trim()) updates.businessName = body.businessName.trim();
    if (body.webhookUrl !== undefined) updates.webhookUrl = body.webhookUrl?.trim() || null;
    if (body.webhookSecret !== undefined && body.webhookSecret.trim()) updates.webhookSecret = body.webhookSecret.trim();

    if (
      body.branding ||
      body.enabledPaymentMethods ||
      body.supportEmails !== undefined ||
      body.supportMobiles !== undefined ||
      body.privacyPolicyUrl !== undefined
    ) {
      const currentBranding = merchant.branding || {};
      const mergedBranding = { ...currentBranding };
      const inputBranding = body.branding || {};

      if (inputBranding.appName !== undefined) mergedBranding.appName = inputBranding.appName.trim() || currentBranding.appName || 'YOUPI PG';
      if (inputBranding.logoUrl !== undefined) mergedBranding.logoUrl = inputBranding.logoUrl ? inputBranding.logoUrl.trim() : null;
      if (inputBranding.primaryColor !== undefined) mergedBranding.primaryColor = inputBranding.primaryColor.trim() || currentBranding.primaryColor || '#2563eb';
      if (inputBranding.sidebarNotice !== undefined) mergedBranding.sidebarNotice = inputBranding.sidebarNotice ? inputBranding.sidebarNotice.trim() : null;
      if (inputBranding.checkoutNotice !== undefined) mergedBranding.checkoutNotice = inputBranding.checkoutNotice ? inputBranding.checkoutNotice.trim() : null;
      if (inputBranding.footerGuarantee !== undefined) mergedBranding.footerGuarantee = inputBranding.footerGuarantee ? inputBranding.footerGuarantee.trim() : null;
      if (inputBranding.counterInstructions !== undefined) mergedBranding.counterInstructions = inputBranding.counterInstructions ? inputBranding.counterInstructions.trim() : null;

      if (body.enabledPaymentMethods && Array.isArray(body.enabledPaymentMethods)) {
        mergedBranding.enabledPaymentMethods = body.enabledPaymentMethods;
      } else if (inputBranding.enabledPaymentMethods && Array.isArray(inputBranding.enabledPaymentMethods)) {
        mergedBranding.enabledPaymentMethods = inputBranding.enabledPaymentMethods;
      }

      if (body.supportEmails !== undefined || inputBranding.supportEmails !== undefined) {
        const raw = body.supportEmails !== undefined ? body.supportEmails : inputBranding.supportEmails;
        mergedBranding.supportEmails = Array.isArray(raw)
          ? raw.map(s => String(s).trim()).filter(Boolean)
          : (typeof raw === 'string' ? raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean) : []);
      }
      if (body.supportMobiles !== undefined || inputBranding.supportMobiles !== undefined) {
        const raw = body.supportMobiles !== undefined ? body.supportMobiles : inputBranding.supportMobiles;
        mergedBranding.supportMobiles = Array.isArray(raw)
          ? raw.map(s => String(s).trim()).filter(Boolean)
          : (typeof raw === 'string' ? raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean) : []);
      }
      if (body.privacyPolicyUrl !== undefined || inputBranding.privacyPolicyUrl !== undefined) {
        const raw = body.privacyPolicyUrl !== undefined ? body.privacyPolicyUrl : inputBranding.privacyPolicyUrl;
        mergedBranding.privacyPolicyUrl = raw ? String(raw).trim() : null;
      }

      updates.branding = mergedBranding;
    }

    const updated = ctx.merchantRepo.update(merchant.id, updates);

    ctx.auditRepo.log({
      merchantId: merchant.id,
      entityType: 'MERCHANT',
      entityId: merchant.id,
      action: 'MERCHANT_SETTINGS_UPDATED',
      actorType: AuditActorType.ADMIN,
      details: updates
    });

    HttpServer.json(res, 200, {
      success: true,
      merchantId: updated.id,
      businessName: updated.businessName,
      webhookUrl: updated.webhookUrl || '',
      webhookSecret: updated.webhookSecret || '',
      supportEmails: updated.branding?.supportEmails || [],
      supportMobiles: updated.branding?.supportMobiles || [],
      privacyPolicyUrl: updated.branding?.privacyPolicyUrl || '',
      branding: updated.branding
    });
  });

  // GET /api/v1/admin/stream (SSE for Live Admin Counter & Queue Events)
  server.get('/api/v1/admin/stream', async (req, res) => {
    server.initSse('admin_counter_events', res);
  });
}
