# ARCHITECTURE.md: Canonical System Architecture & Engineering Blueprint

## 1. Executive Summary & Product Mission
YOUPI PG is a self-hosted, white-label UPI payment gateway designed for small businesses and merchants. It is distributed as pure source code. Each merchant deployment runs independently on the customer's own infrastructure with its own database, backend, receiving accounts, observation channels, customer portal, and admin dashboard.

### Core Invariants
1. **Zero Docker Dependency:** Operates exclusively as native host processes (Node.js/TypeScript, PostgreSQL, Android native app) on standard Linux and Windows environments.
2. **Deterministic Amount-Only Attribution:** The payment attribution rule is:
   $$\text{expected\_amount} == \text{observed\_amount}$$
3. **Exclusive Single-Active-Payment Slot:** Exactly ONE payment session per receiving account is in `ACTIVE` or `PROCESSING` at any instant. All other customers are `QUEUED`.
4. **Tri-Channel Observation Engine:** Simultaneous observation via Gmail OAuth, Android Notification Listener, and Google Messages Web Automation feeding into a single, unified observation normalizer.
5. **Dual-Timer Engine:** 
   - **5-Minute Payment Window (`ACTIVE`):** Countdown for customer to pay. Server-authoritative, immutable, survives browser refreshes and server restarts.
   - **30-Second Processing Window (`PROCESSING`):** Starts ONLY when customer clicks "PAYMENT DONE — CHECK MY PAYMENT". Completely separate from the 5-minute timer. All observers operate actively during this window.
6. **Public Merchant Contract Simplicity:** External merchants consume only four deterministic terminal states: `SUCCESS`, `FAILED`, `EXPIRED`, `CANCELLED`.
7. **Complete Customer-Merchant Data Isolation:** Multi-tenant support within a single instance strictly isolates data between merchant accounts.

---

## 2. System Architecture & Component Diagram

```
                 SELF-HOSTED CLIENT DEPLOYMENT
                 ==============================

                         PAYMENT BACKEND (Port 6100)
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
   CHECKOUT PORTAL       MERCHANT ADMIN       PAYMENT HELP
     (Port 7000)          (Port 6001)          (Port 3000)
          |                    |                    |
          +--------------------+--------------------+
                               |
                         PAYMENT CORE
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
    QUEUE ENGINE         TIMING ENGINE         EVENT ENGINE
          |                    |                    |
          +--------------------+--------------------+
                               |
                    PAYMENT DETECTION ENGINE
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
            Gmail           Android             SMS
           Observer         Observer           Observer
          (Port 6003)    (Kotlin Native)      (Port 6002)
              |                |                |
              +----------------+----------------+
                               |
                      OBSERVATION NORMALIZER
                               |
                      ATTRIBUTION ENGINE
                               |
                  SUCCESS / FAILED / ETC.
                               |
                       MERCHANT EVENT
                               |
                         WEBHOOK / ACTION
                               |
                    CLIENT BUSINESS SYSTEM
```

---

## 3. State Machine & Transition Invariants

### 3.1 Public Merchant Outcomes
The external contract exposes ONLY 4 terminal states:
- `SUCCESS`: Payment observed and verified by backend engine.
- `FAILED`: 30-second processing window expired with no matching payment observation.
- `EXPIRED`: 5-minute payment window elapsed without customer clicking "Payment Done".
- `CANCELLED`: Explicitly cancelled by customer during active window.

### 3.2 High-Resolution Internal States
```
INITIATED -> [Slot Check]
              |-- Slot Free -> ACTIVE (5:00 timer starts)
              |-- Slot Busy -> QUEUED (waits in position)
QUEUED    -> ACTIVE (when previous session finishes)
ACTIVE    -> PROCESSING (customer clicks "Payment Done", 30s timer starts)
          -> EXPIRED (5:00 reaches 0 without click)
          -> CANCELLED (customer clicks "Cancel")
PROCESSING-> SUCCESS (amount-matched observation verified)
          -> FAILED (30s reaches 0 with no match)
```

---

## 4. Late Observation & Deduplication Strategy

### 4.1 Deduplication
- Every incoming observation is fingerprinted: `SHA-256(receivingAccount + amountPaise + referenceNumber || timeBucket)`.
- If an observation matches an already attributed cluster, it is tagged `DUPLICATE_IGNORED` and logged without triggering secondary state mutations.

### 4.2 Late Observations
- If an observation arrives when no active session matches:
  - Stored as `UNATTRIBUTED`.
  - Evaluated against recently expired/failed sessions ($< 30$ mins) matching the amount and receiving account.
  - If a historical match is found: tagged `LATE_MATCH_FOUND`, a reconciliation support ticket is auto-generated for Merchant Admin, and webhook `PAYMENT.LATE_DETECTED` is emitted.
  - **Critical Invariant:** An old observation is NEVER attributed to a new, different customer session in the queue.

---

## 5. Security & Threat Model

1. **Integer Minor Units (Paise):** Financial values stored strictly as 64-bit integers (`BIGINT`). Zero floating point arithmetic.
2. **Zero Client Trust:** All timers and state transitions are server-authoritative.
3. **Encrypted Secrets:** Stored with AES-256-GCM using `ENCRYPTION_MASTER_KEY`.
4. **Android Pairing Security:** Ephemeral QR enrollment tokens, HMAC-SHA256 device signing keys, timestamp anti-replay checks ($< 60$s drift).
5. **Signed Webhooks:** `HMAC-SHA256(merchant.webhook_secret, payload)` with exponential backoff retries.

---

## 6. Gateway-Owned Customer Identity & Session Architecture

1. **Gateway as Exclusive Identity Owner:** The Payment Gateway is the sole owner of customer identity. Merchant applications and storefronts do not collect, authenticate, or manage customer credentials. Merchant systems initiate payments (`orderId`, `amount`, `returnUrl`) and immediately redirect customers to the hosted Payment Gateway.
2. **Customer Identity Profile (4 User Fields):**
   - Full Name
   - Normalized Email Address
   - Normalized 10-Digit Mobile Number
   - Strong Password (minimum 6 characters)
3. **Password Security Standard:**
   - PBKDF2 with SHA-512 and 100,000 iterations using unique 16-byte cryptographic salts.
   - Constant-time verification (`crypto.timingSafeEqual`).
   - Plaintext passwords are never stored, logged, or returned in API responses.
4. **Server-Authoritative Customer Sessions:**
   - Dedicated `customer_sessions` table with cryptographically secure session tokens (`csess_...`), expiration timestamps, and revocation support.
5. **Pre-Gateway Authentication Gate & Payment Invariant:**
   - Unauthenticated checkout sessions cannot start payment timers, acquire receiving account slots, or enter queues.
   - Slot acquisition and the 5-minute active timer begin only after customer authentication.
6. **Payment Session Identity Immutability:**
   - Once a payment session starts, its customer binding is immutable. Cross-account hijacking or tampering is rejected with HTTP 409 Conflict.
7. **Remembered Browser Accounts (Max 2):**
   - Safe client-side account switcher (`youpi.customer.accounts`) remembering up to 2 accounts with opaque session tokens (no plaintext passwords). Automatic session restoration on return, manual switching, and session-invalidating logout.

---

## 7. Service Port Topology

| Service | Port | Environment Variable |
| :--- | :--- | :--- |
| Customer Payment Help Portal | 3000 | `HELP_PORTAL_PORT` |
| SMS / Google Messages Observer | 6002 | `SMS_OBSERVER_PORT` |
| Gmail Observer Service | 6003 | `GMAIL_OBSERVER_PORT` |
| Merchant Admin Dashboard | 6001 | `MERCHANT_ADMIN_PORT` |
| Payment Core REST API | 6100 | `PAYMENT_API_PORT` |
| Checkout Portal | 7000 | `CHECKOUT_PORTAL_PORT` |
| Local Process Control Center | 8090 | `CONTROL_CENTER_PORT` |
