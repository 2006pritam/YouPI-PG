---
name: youpi-security-audit
description: Verify payment state machine invariants, raw payload HMAC signatures, device binding fail-closed security, and session token enforcement. Use when modifying checkout endpoints, webhook delivery, auth guards, or running security regression test suites.
metadata:
  version: "1.0.0"
---

# YouPI Security & Invariants Audit Skill

Use this skill when auditing or modifying core payment APIs, checkout lifecycle, webhook signatures, or authorization guards in YOUPI PG V2.

## Mandatory Architectural & Security Invariants

### 1. Server-to-Server HMAC Signature Over Raw Bytes
- The HMAC-SHA256 signature (`X-Gateway-Signature`) **MUST be computed over the raw, unparsed request payload string**.
- Never parse JSON before computing HMAC.
- Header contracts:
  - `X-Gateway-Signature: sha256=<hex>`
  - `X-Gateway-Timestamp: <ms>`
  - `X-Gateway-Event: SUCCESS`
  - `X-Gateway-Delivery-Id: <uuid>`
- Signature verification helper: `YoupiPaymentClient.verifyWebhook(rawBody, signature, secret, timestamp)` enforces freshness window (default 300s).

### 2. Device Binding & Fail-Closed Access Control
- `checkSessionDeviceAccess(session, req, body, ctx)` in `apps/payment-api/src/routes/checkout.routes.js`:
  - When a payment session is bound to an active device (`session.deviceId`), requests omitting `X-Device-Id` **MUST fail closed** with `HTTP 401 DEVICE_ID_REQUIRED`.
  - Mismatched device identities must return `HTTP 409 DUPLICATE_SESSION_DETECTED`.
  - Admin tokens (`ADMIN_API_TOKEN`) and owning merchant API keys (`X-Merchant-Key`) bypass device lock for administrative support.

### 3. Payment Creation Guard (`POST /api/v1/payments`)
- Requests require a valid `X-Merchant-Key` (matching `apiKeyHash` with fallback to `webhookSecret`), or authenticated admin token.
- `autoActivate: true` is strictly forbidden in production unless authorized by admin credentials or verified test mode, returning `HTTP 403 AUTOACTIVATE_FORBIDDEN`.

### 4. Running Verification Test Suites
Verify all invariants locally before committing:
```bash
npm run typecheck
npm test
```
All 38 test suites must pass 100% cleanly.
