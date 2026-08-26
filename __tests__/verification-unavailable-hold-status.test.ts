/**
 * #153 — the properties of `verification_unavailable_hold`, pinned where they are DERIVED rather
 * than where they are used.
 *
 * Modelled on __tests__/amount-mismatch-hold-status.test.ts, because the two statuses are the same
 * shape with different causes and the pair must not drift apart silently. Each assertion below is
 * a decision that costs money if it is reversed by accident:
 *
 *   owesMoney            — omit it and the order drops out of a tab's unpaid total, and can_close
 *                          reports true over genuine debt.
 *   NOT cash-settleable  — include it and staff get a cash button for an order that may already
 *                          have been charged on the reader. Collecting twice is worse than the
 *                          hold.
 *   NOT card-claimable   — include it and a card settlement sweeps up an order whose gateway state
 *                          nobody can establish.
 *   NOT 'pending'        — the whole mechanism. The sweep's candidate filter is
 *                          payment_status = 'pending', so a held order leaves the retry loop by
 *                          construction rather than by a counter someone has to maintain.
 */
import {
  CASH_SETTLEABLE_PAYMENT_STATUSES,
  CLAIMABLE_PAYMENT_STATUSES,
  HELD_FOR_REVIEW_PAYMENT_STATUSES,
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  isHeldForReviewPaymentStatus,
  isPaidPaymentStatus,
  OWES_MONEY_PAYMENT_STATUSES,
  owesMoney,
  VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
  AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
} from '@/lib/payments/payment-integrity'

const HOLD = VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS

describe('verification_unavailable_hold', () => {
  it('still owes the restaurant money', () => {
    expect(owesMoney(HOLD)).toBe(true)
    expect([...OWES_MONEY_PAYMENT_STATUSES]).toContain(HOLD)
  })

  it('is NOT cash-settleable — a charge may already exist on the reader', () => {
    expect(isCashSettleablePaymentStatus(HOLD)).toBe(false)
    expect([...CASH_SETTLEABLE_PAYMENT_STATUSES]).not.toContain(HOLD)
  })

  it('is NOT claimable by a card settlement', () => {
    expect(isClaimablePaymentStatus(HOLD)).toBe(false)
    expect([...CLAIMABLE_PAYMENT_STATUSES]).not.toContain(HOLD)
  })

  it('is a held-for-review status, alongside the amount-mismatch hold', () => {
    expect(isHeldForReviewPaymentStatus(HOLD)).toBe(true)
    expect([...HELD_FOR_REVIEW_PAYMENT_STATUSES]).toContain(HOLD)
    expect([...HELD_FOR_REVIEW_PAYMENT_STATUSES]).toContain(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)
  })

  it('is neither pending nor paid nor cancelled', () => {
    // Not 'pending' is what actually ends the retry loop: it is the sweep's candidate filter.
    expect(HOLD).not.toBe('pending')
    expect(HOLD).not.toBe(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)
    expect(isPaidPaymentStatus(HOLD)).toBe(false)
    expect(HOLD).not.toBe('cancelled')
  })

  it('normalises like every other status — a stray case or space cannot slip past', () => {
    expect(owesMoney(` ${HOLD.toUpperCase()} `)).toBe(true)
    expect(isHeldForReviewPaymentStatus(` ${HOLD.toUpperCase()} `)).toBe(true)
  })
})
