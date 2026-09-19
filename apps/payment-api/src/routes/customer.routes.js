import { HttpServer } from '../server.js';
import { normalizeEmail, normalizeMobile, isValidEmail, isValidMobile, isValidPassword } from '@youpi/common';

/**
 * Registers gateway-owned customer identity and session routes.
 * @param {HttpServer} server
 * @param {{
 *   customerRepo: import('@youpi/db').CustomerRepository,
 *   customerSessionRepo: import('@youpi/db').CustomerSessionRepository,
 *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
 *   auditRepo: import('@youpi/db').AuditLogRepository
 * }} ctx
 */
export function registerCustomerRoutes(server, ctx) {
  // Helper to extract session token from Authorization header or Cookie
  function extractSessionToken(req) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookieHeader = req.headers['cookie'] || '';
    const match = cookieHeader.match(/youpi_session=([^;]+)/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  // Helper to set session cookie header
  function buildSessionCookie(token, maxAgeSeconds = 30 * 24 * 3600) {
    return `youpi_session=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax`;
  }

  // POST /api/v1/customer/register (Gateway-owned Sign Up)
  // Input: exactly name, email, mobileNumber, password
  server.post('/api/v1/customer/register', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const { name, email, mobileNumber, password } = body;

    // Backward-compatibility field fallback if legacy fields are sent
    const resolvedName = (name || body.fullName || '').trim();
    const resolvedMobile = normalizeMobile(mobileNumber || body.phoneNumber);
    let resolvedEmail = normalizeEmail(email);
    if (!resolvedEmail && resolvedMobile) {
      resolvedEmail = `${resolvedMobile}@customer.youpi.local`;
    }
    const resolvedPassword = password;

    if (!resolvedName) {
      HttpServer.json(res, 400, { error: 'Name is required.' });
      return;
    }
    if (!resolvedEmail || !isValidEmail(resolvedEmail)) {
      HttpServer.json(res, 400, { error: 'A valid email address is required.' });
      return;
    }
    if (!resolvedMobile || !isValidMobile(resolvedMobile)) {
      HttpServer.json(res, 400, { error: 'A valid 10-digit mobile number is required.' });
      return;
    }
    if (!isValidPassword(resolvedPassword)) {
      HttpServer.json(res, 400, { error: 'Password must be at least 6 characters long.' });
      return;
    }

    // Check unique email
    const existingByEmail = ctx.customerRepo.findByEmail(resolvedEmail);
    if (existingByEmail) {
      HttpServer.json(res, 409, { error: 'An account with this email address already exists.' });
      return;
    }

    // Check unique mobile
    const existingByMobile = ctx.customerRepo.findByMobile(resolvedMobile);
    if (existingByMobile) {
      HttpServer.json(res, 409, { error: 'An account with this mobile number already exists.' });
      return;
    }

    let customer;
    try {
      customer = ctx.customerRepo.create({
        name: resolvedName,
        email: resolvedEmail,
        mobileNumber: resolvedMobile,
        password: resolvedPassword
      });
    } catch (err) {
      HttpServer.json(res, 400, { error: err.message });
      return;
    }

    // Create authenticated server-authoritative session
    const ipAddress = req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = ctx.customerSessionRepo.create({
      customerId: customer.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: customer.id,
        action: 'CUSTOMER_REGISTERED',
        actorType: 'CUSTOMER',
        actorId: customer.id,
        details: { email: customer.email, mobileNumber: customer.mobileNumber }
      });
    }

    HttpServer.json(res, 201, {
      success: true,
      token: session.token,
      customerId: customer.id,
      phoneNumber: customer.mobileNumber,
      fullName: customer.name,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        createdAt: customer.createdAt
      }
    });
  });

  // POST /api/v1/customer/login (Gateway-owned Sign In)
  // Input: identifier (email or mobile) + password
  server.post('/api/v1/customer/login', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const identifier = (body.identifier || body.email || body.mobileNumber || body.phoneNumber || '').trim();
    const password = body.password;

    if (!identifier || !password) {
      HttpServer.json(res, 400, { error: 'Email/mobile number and password are required.' });
      return;
    }

    const verified = ctx.customerRepo.verifyCredentials(identifier, password);
    if (!verified) {
      HttpServer.json(res, 401, { error: 'Invalid credentials. Please check your email/mobile and password.' });
      return;
    }

    // Create session
    const ipAddress = req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;
    const session = ctx.customerSessionRepo.create({
      customerId: verified.id,
      ipAddress,
      userAgent
    });

    res.setHeader('Set-Cookie', buildSessionCookie(session.token));

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        entityType: 'CUSTOMER',
        entityId: verified.id,
        action: 'CUSTOMER_LOGGED_IN',
        actorType: 'CUSTOMER',
        actorId: verified.id,
        details: { identifier }
      });
    }

    HttpServer.json(res, 200, {
      success: true,
      token: session.token,
      customerId: verified.id,
      phoneNumber: verified.mobileNumber,
      fullName: verified.name,
      customer: {
        id: verified.id,
        name: verified.name,
        email: verified.email,
        mobileNumber: verified.mobileNumber,
        status: verified.status,
        lastLoginAt: verified.lastLoginAt
      }
    });
  });

  // GET /api/v1/customer/me (Verify active session & return profile)
  server.get('/api/v1/customer/me', async (req, res) => {
    const token = extractSessionToken(req);
    if (!token) {
      HttpServer.json(res, 401, { error: 'No active session token provided.' });
      return;
    }

    const authContext = ctx.customerSessionRepo.findByToken(token);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Session expired or invalid.' });
      return;
    }

    const { customer, session } = authContext;
    HttpServer.json(res, 200, {
      authenticated: true,
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt
      },
      session: {
        id: session.id,
        expiresAt: session.expiresAt
      }
    });
  });

  // POST /api/v1/customer/logout (Revoke active session token)
  server.post('/api/v1/customer/logout', async (req, res) => {
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const token = extractSessionToken(req) || body.token;

    if (token) {
      ctx.customerSessionRepo.revokeToken(token);
    }

    res.setHeader('Set-Cookie', 'youpi_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    HttpServer.json(res, 200, { success: true, message: 'Logged out successfully.' });
  });

  // POST /api/v1/customer/switch-account (Validates target saved account token)
  server.post('/api/v1/customer/switch-account', async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const targetToken = body.token || body.sessionToken;

    if (!targetToken) {
      HttpServer.json(res, 400, { error: 'Target account session token is required.' });
      return;
    }

    const authContext = ctx.customerSessionRepo.findByToken(targetToken);
    if (!authContext) {
      HttpServer.json(res, 401, { error: 'Target account session has expired. Please log in again.' });
      return;
    }

    res.setHeader('Set-Cookie', buildSessionCookie(authContext.session.token));

    HttpServer.json(res, 200, {
      success: true,
      token: authContext.session.token,
      customer: {
        id: authContext.customer.id,
        name: authContext.customer.name,
        email: authContext.customer.email,
        mobileNumber: authContext.customer.mobileNumber
      }
    });
  });

  // Decommissioned Customer Endpoints (HTTP 404)
  server.get('/api/v1/customer/payments', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.post('/api/v1/customer/tickets/:id/messages', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });

  server.get('/api/v1/customer/tickets/:id/stream', async (req, res) => {
    HttpServer.json(res, 404, { error: 'Feature not available' });
  });
}
