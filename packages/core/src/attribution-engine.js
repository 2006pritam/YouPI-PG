import { PaymentStatus, ObservationAttributionStatus, TicketStatus, SenderType } from '@youpi/common';

export class AttributionEngine {
  /**
   * @param {{
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   obsRepo: import('@youpi/db').ObservationRepository,
   *   ticketRepo?: import('@youpi/db').SupportTicketRepository,
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   eventEmitter?: { emit: (event: string, payload: any) => void }
   * }} options
   */
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.ticketRepo = options.ticketRepo;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
  }

  /**
   * Processes a normalized canonical observation through the attribution pipeline.
   * @param {ReturnType<typeof import('./normalizer.js').ObservationNormalizer.normalize>} normalizedObs
   * @returns {{
   *   attributed: boolean,
   *   duplicate: boolean,
   *   lateMatch: boolean,
   *   paymentSessionId?: string,
   *   observationId: string,
   *   outcomeStatus: string
   * }}
   */
  processObservation(normalizedObs) {
    // Tier 1: Check fingerprint for deduplication
    const existing = this.obsRepo.findByFingerprint(normalizedObs.fingerprintHash);
    if (existing) {
      // If observation came from the SAME source, drop as redundant duplicate
      if (existing.source === normalizedObs.source) {
        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_OBSERVATION',
            entityId: existing.id,
            action: 'DUPLICATE_OBSERVATION_DROPPED',
            actorType: 'OBSERVER',
            details: { fingerprintHash: normalizedObs.fingerprintHash, source: normalizedObs.source }
          });
        }
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId || undefined,
          observationId: existing.id,
          outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
        };
      }

      // If observation came from a NEW, DIFFERENT channel and payment was already attributed:
      // Upgrade verification tier to Level 2 (Dual Verification)!
      if (existing.attributedPaymentId) {
        const savedObs = this.obsRepo.create(normalizedObs);
        const verifyResult = this.sessionRepo.recordVerificationSource(
          existing.attributedPaymentId,
          normalizedObs.source,
          savedObs.id
        );
        this.obsRepo.markAttributed(savedObs.id, existing.attributedPaymentId);

        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: existing.attributedPaymentId,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              source: normalizedObs.source,
              level: verifyResult.level,
              tag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: existing.attributedPaymentId,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Persist new observation as UNATTRIBUTED first
    const savedObs = this.obsRepo.create(normalizedObs);

    // Tier 2: Check currently active session on receiving account
    let currentSession = this.sessionRepo.findCurrentActiveOrProcessing(normalizedObs.receivingAccountId);
    if (!currentSession) {
      // Fallback: Check if there is an ACTIVE or PROCESSING session matching this exact amount anywhere on the gateway
      const anyActive = this.sessionRepo.db.queryOne(`
        SELECT * FROM payment_sessions
        WHERE status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [Number(normalizedObs.amountPaise)]);
      if (anyActive) {
        currentSession = this.sessionRepo.mapRow(anyActive);
      }
    }

    if (currentSession) {
      // Invariant Check 1: Must be in ACTIVE or PROCESSING status
      const isEligibleStatus = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(currentSession.status);

      // Invariant Check 2: Exact Amount Match (in integer paise)
      const isAmountMatch = currentSession.amountPaise === normalizedObs.amountPaise;

      // Invariant Check 3: Temporal Window (with 5-minute clock skew tolerance, strictly preventing hijacking of prior expired sessions)
      let isPriorExpiredSession = false;
      if (currentSession.slotAcquiredAt && normalizedObs.observedAt < currentSession.slotAcquiredAt) {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
          normalizedObs.receivingAccountId,
          thirtyMinutesAgo
        );
        isPriorExpiredSession = recentExpired.some(s => s.amountPaise === normalizedObs.amountPaise);
      }

      const slotStart = currentSession.slotAcquiredAt
        ? new Date(currentSession.slotAcquiredAt.getTime() - 300000)
        : new Date(currentSession.createdAt.getTime() - 300000);

      const isTimeValid = !isPriorExpiredSession && (normalizedObs.observedAt >= slotStart);

      if (isEligibleStatus && isAmountMatch && isTimeValid) {
        const wasActive = currentSession.status === PaymentStatus.ACTIVE;

        // If payment notification arrived while user was on active QR screen, trigger 30s processing window
        if (wasActive) {
          this.eventEmitter.emit('SESSION.PROCESSING', {
            sessionId: currentSession.id,
            receivingAccountId: currentSession.receivingAccountId,
            processingExpiresAt: new Date(Date.now() + 30000)
          });
        }

        // 2-Level Verification Engine: Record observation confirmation and compute verification tier
        const verifyResult = this.sessionRepo.recordVerificationSource(
          currentSession.id,
          normalizedObs.source,
          savedObs.id
        );

        // Mark observation ATTRIBUTED
        this.obsRepo.markAttributed(savedObs.id, currentSession.id);

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: currentSession.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: currentSession.id,
            action: verifyResult.isFirstSuccess ? 'PAYMENT_ATTRIBUTED_SUCCESS' : 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        // Emit SUCCESS event for webhook/event engine
        if (verifyResult.isFirstSuccess) {
          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
        } else {
          this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
        }

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          wasActive,
          paymentSessionId: currentSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Check if observation confirms a recently successful session on this receiving account (within 60s)
    // Upgrades verification level (e.g. from Level 1 -> Level 2 -> Level 3)
    const recentSuccessSession = this.sessionRepo.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = 'SUCCESS'
        AND amount_paise = ? AND completed_at >= datetime('now', '-60 seconds')
      ORDER BY completed_at DESC LIMIT 1
    `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);

    if (recentSuccessSession) {
      // Check if this session's attributed observation had a UTR
      const existingObs = recentSuccessSession.attributed_observation_id
        ? this.obsRepo.findById(recentSuccessSession.attributed_observation_id)
        : null;

      // If both have UTRs and they do NOT match, this is NOT the same transaction!
      const isUtrConflict = normalizedObs.bankReferenceNumber &&
        existingObs?.bankReferenceNumber &&
        normalizedObs.bankReferenceNumber !== existingObs.bankReferenceNumber;

      const sessionSlotStart = recentSuccessSession.slot_acquired_at
        ? new Date(new Date(recentSuccessSession.slot_acquired_at).getTime() - 30000)
        : new Date(new Date(recentSuccessSession.created_at).getTime() - 30000);
      const sessionCompleted = recentSuccessSession.completed_at
        ? new Date(new Date(recentSuccessSession.completed_at).getTime() + 30000)
        : new Date();

      // Temporal check: observation must have been observed during this session's window
      if (!isUtrConflict && normalizedObs.observedAt >= sessionSlotStart && normalizedObs.observedAt <= sessionCompleted) {
        const verifyResult = this.sessionRepo.recordVerificationSource(
          recentSuccessSession.id,
          normalizedObs.source,
          savedObs.id
        );

        this.obsRepo.markAttributed(savedObs.id, recentSuccessSession.id);

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: recentSuccessSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Tier 3: Late Observation Handling
    // Check if observation matches a recently expired or failed session on this receiving account (< 30 mins)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
      normalizedObs.receivingAccountId,
      thirtyMinutesAgo
    );

    const lateMatchedSession = recentExpired.find(s => s.amountPaise === normalizedObs.amountPaise);

    if (lateMatchedSession) {
      // Mark observation as LATE_UNMATCHED
      this.obsRepo.markLateUnmatched(savedObs.id);

      if (this.auditRepo) {
        this.auditRepo.log({
          merchantId: lateMatchedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: lateMatchedSession.id,
          action: 'LATE_OBSERVATION_DETECTED',
          actorType: 'SYSTEM',
          details: {
            observationId: savedObs.id,
            source: normalizedObs.source,
            amountPaise: normalizedObs.amountPaise.toString(),
            sessionStatus: lateMatchedSession.status
          }
        });
      }

      // Automatically create a high-priority reconciliation support ticket if customer exists
      if (this.ticketRepo && lateMatchedSession.customerId) {
        this.ticketRepo.createTicket({
          merchantId: lateMatchedSession.merchantId,
          customerId: lateMatchedSession.customerId,
          paymentId: lateMatchedSession.id,
          subject: `[LATE PAYMENT DETECTED] Order #${lateMatchedSession.orderId}`,
          status: TicketStatus.OPEN,
          initialMessage: {
            senderType: SenderType.ADMIN,
            senderId: lateMatchedSession.merchantId,
            message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${lateMatchedSession.id} ended with status ${lateMatchedSession.status}. Flagged for manual merchant reconciliation.`
          }
        });
      }

      // Emit LATE_DETECTED event
      this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
        paymentId: lateMatchedSession.id,
        orderId: lateMatchedSession.orderId,
        merchantId: lateMatchedSession.merchantId,
        amountPaise: normalizedObs.amountPaise,
        observationId: savedObs.id
      });

      return {
        attributed: false,
        duplicate: false,
        lateMatch: true,
        paymentSessionId: lateMatchedSession.id,
        observationId: savedObs.id,
        outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
      };
    }

    // Unattributed observation
    return {
      attributed: false,
      duplicate: false,
      lateMatch: false,
      observationId: savedObs.id,
      outcomeStatus: ObservationAttributionStatus.UNATTRIBUTED
    };
  }
}
