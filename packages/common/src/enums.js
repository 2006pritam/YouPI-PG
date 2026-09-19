/**
 * Internal high-resolution payment session lifecycle states.
 */
export const PaymentStatus = Object.freeze({
  INITIATED: 'INITIATED',
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Public-facing payment outcomes consumed by external merchants.
 */
export const PublicPaymentOutcome = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Supported payment modalities.
 */
export const PaymentMethod = Object.freeze({
  UPI: 'UPI',
  CASH_COUNTER: 'CASH_COUNTER',
  CARD_COUNTER: 'CARD_COUNTER'
});

/**
 * Observation channel sources feeding the payment detection engine (2-Layer: SMS + Gmail).
 * Android observer layer is completely removed.
 */
export const ObserverSource = Object.freeze({
  GMAIL: 'GMAIL',
  GOOGLE_MESSAGES: 'GOOGLE_MESSAGES',
  MANUAL_COUNTER: 'MANUAL_COUNTER'
});

/**
 * Attribution status for raw observations.
 */
export const ObservationAttributionStatus = Object.freeze({
  UNATTRIBUTED: 'UNATTRIBUTED',
  ATTRIBUTED: 'ATTRIBUTED',
  LATE_UNMATCHED: 'LATE_UNMATCHED',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED'
});

/**
 * Support ticket lifecycle states.
 */
export const TicketStatus = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});

/**
 * Live chat message sender identity type.
 */
export const SenderType = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN'
});

/**
 * Audit log actor classifications.
 */
export const AuditActorType = Object.freeze({
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  OBSERVER: 'OBSERVER'
});
