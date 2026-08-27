/**
 * #160 — the three states POST /api/terminal/orders/[orderId]/prepare-payment can land in, named,
 * and the ONE place their staff-facing wording lives.
 *
 * THE DEFECT THIS CLOSES. prepare-payment allocated `orders.paycloud_merchant_order_no` without
 * ever asking whether the venue has Finatic credentials, so at a venue with none it handed the
 * device a reference that looks gateway-issued, is not, and can never afterwards be queried by
 * anything. Measured on production 2026-08-27: four such orders exist, all at Digi Cofee, and TWO
 * of them were minted on the evening of 2026-08-26 (#28 FT17877758635420962 and
 * #29 FT17877763600963039). #28's trail then shows five `payment.verification_uncertain` rows in
 * six minutes, every one of them carrying `No Finatic credentials configured for restaurant`.
 * That is the loop: a question being asked over and over that could never have been answered,
 * because the answer was already fixed before the customer tapped anything.
 *
 * WHY THREE AND NOT ONE. The three states below tell a human three DIFFERENT things to do —
 * take payment another way / look at this order / wait a moment and retry. Collapsing any two of
 * them removes the instruction that would have ended the loop. This is the same discrimination
 * #153 made on the verification side (lib/payments/verify-payment-outcome.ts) and in the sweep
 * (lib/orders/auto-cancel-stale-pos-orders.ts), applied one step earlier — at the moment the
 * identifier is minted rather than at the moment somebody tries to reconcile it.
 *
 * WHY A CODE AND A MESSAGE, RATHER THAN A MESSAGE. Same reasoning as verify-payment-outcome.ts:
 * the APK cannot branch on prose. `outcome` is the stable contract a terminal build reads; the
 * message is what a build that does not recognise the outcome shows instead, which is every build
 * in the field today.
 *
 * WHY `outcome` AND NOT `code`. The route's existing `code` field already carries ALREADY_PAID and
 * ORDER_CANCELLED, and those two strings are used by four other routes
 * (push-to-terminal, payments/receipt, terminal payment, terminal tabs settle). Reusing `code` for
 * the three-state vocabulary would silently change what a fielded build reads on a path that
 * predates this issue. `outcome` is additive: old builds keep reading `code` and `error` exactly as
 * they did, new builds branch on `outcome`.
 *
 * ============================================================================================
 * THE STRINGS BELOW ARE PLACEHOLDERS AND MUST BE REPLACED BEFORE THIS SHIPS TO A DEVICE.
 * ============================================================================================
 *
 * They carry the `PENDING COPY` marker deliberately, so scripts/check-no-pending-copy.mjs blocks
 * the production deploy until each one has been signed off. That gate is production-only by design
 * — staging is where a marked placeholder is supposed to live while the wording is settled. Do not
 * delete a marker to get a deploy through; get the wording and replace the string.
 *
 * NOTE FOR WHOEVER SIGNS THESE OFF: lib/payments/verify-payment-outcome.ts holds three sibling
 * strings for the verification side. They spell the marker `[COPY PENDING: ...]`, which
 * check-no-pending-copy.mjs does not match, so they can reach production unsigned. That is a
 * separate finding and is deliberately not changed here.
 */

export const PREPARE_PAYMENT_OUTCOME_CODES = {
  /**
   * This venue has no Finatic merchant/store pair, so no card can be settled here and no
   * reference can be honoured. PERMANENT until someone configures the venue. Nothing was
   * allocated and no card was presented.
   *
   * Copy must convey: card payment is not set up at this venue; this is a SETUP problem, not a
   * fault with this order or with the network; retrying will not help; take payment another way
   * and tell whoever administers the venue. It must NOT say the payment failed, because no
   * payment was ever attempted.
   */
  CARD_NOT_AVAILABLE_HERE: 'prepare_card_not_available_here',

  /**
   * The preparation itself could not complete for a definite, known reason about THIS ORDER —
   * it is already paid, it is cancelled, it does not exist, or a unique reference could not be
   * allocated. The venue is fine; this order is not in a state that can take a fresh card.
   *
   * Copy must convey: this order cannot be prepared for a card payment right now; no card has
   * been presented and nothing has been charged; the order needs looking at rather than
   * retrying.
   */
  PREPARE_FAILED: 'prepare_failed',

  /**
   * We could not establish whether this venue can take a card — the credential read itself
   * failed. TRANSIENT. This is NOT the same as knowing there are no credentials, and it must not
   * be presented as one: a failed read is an absent answer, and answering it with
   * CARD_NOT_AVAILABLE_HERE would tell staff a venue that takes cards every day has never been
   * configured.
   *
   * Copy must convey: we could not check whether card payment is available; nothing was
   * allocated and no card was presented; try again shortly. It must NOT say card payment is
   * unavailable, and it must NOT say the payment failed.
   */
  READINESS_UNKNOWN: 'prepare_readiness_unknown',
} as const

export type PreparePaymentOutcomeCode =
  (typeof PREPARE_PAYMENT_OUTCOME_CODES)[keyof typeof PREPARE_PAYMENT_OUTCOME_CODES]

/** PLACEHOLDER COPY — replace with the owner-signed strings. See the block comment above. */
export const PREPARE_PAYMENT_STAFF_MESSAGE: Record<PreparePaymentOutcomeCode, string> = {
  [PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE]:
    'PENDING COPY: prepare_card_not_available_here — card payment is not set up at this venue, ' +
    'this is a setup problem and not a payment failure, retrying will not help, take payment ' +
    'another way',
  [PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED]:
    'PENDING COPY: prepare_failed — this order cannot be prepared for a card payment, nothing ' +
    'has been charged, the order needs looking at rather than retrying',
  [PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN]:
    'PENDING COPY: prepare_readiness_unknown — we could not check whether card payment is ' +
    'available here, nothing was allocated and no card was presented, try again shortly',
}

/** audit_logs.action written when prepare-payment refuses because the venue cannot settle a card. */
export const PREPARE_REFUSED_NO_CREDENTIALS_ACTION = 'payment.prepare_refused_no_credentials'
