/**
 * #223 — the quarantine status, and the two allowlists it MUST and MUST NOT join.
 *
 * These import the shipped sets rather than restating them, so a future edit to
 * lib/payments/payment-integrity.ts is what makes them fail (#205).
 *
 * The status itself is cheap. What is expensive is getting its MEMBERSHIP wrong, in either
 * direction, and each direction has a named consequence below.
 */
import {
  AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
  CASH_SETTLEABLE_PAYMENT_STATUSES,
  CLAIMABLE_PAYMENT_STATUSES,
  OWES_MONEY_PAYMENT_STATUSES,
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  isHeldForReviewPaymentStatus,
  owesMoney,
} from '../lib/payments/payment-integrity'

describe('#223 — a held order still owes money', () => {
  it('is in OWES_MONEY, or the tab under-reports and can_close lies over real debt', () => {
    // The failure this prevents is named in OWES_MONEY's own docstring: a status left out of
    // this set drops the order out of the tab's unpaid total, and app/api/terminal/tables
    // computes canClose = unpaidOrders.length === 0 from exactly that filter. A held order has
    // NOT been collected on -- the amount is unresolved, so the money is unresolved.
    expect(owesMoney(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)).toBe(true)
    expect([...OWES_MONEY_PAYMENT_STATUSES]).toContain(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)
  })

  it('is NOT cash-settleable — the card was already charged, so cash would collect twice', () => {
    // This is the one that does not fall out of the derivation. CASH_SETTLEABLE is
    // OWES_MONEY minus mid-flight card payments, so adding the hold to OWES_MONEY would have
    // made it cash-settleable by default and put a cash button on an order the customer has
    // already paid by card. Excluded explicitly, and NOT by calling it mid-flight, because the
    // attempt finished -- what is unresolved is the figure.
    expect(isCashSettleablePaymentStatus(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)).toBe(false)
    expect([...CASH_SETTLEABLE_PAYMENT_STATUSES]).not.toContain(
      AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
    )
  })

  it('is NOT card-claimable — a settlement must not sweep up an unresolved figure', () => {
    expect(isClaimablePaymentStatus(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)).toBe(false)
    expect([...CLAIMABLE_PAYMENT_STATUSES]).not.toContain(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)
  })

  it('is recognised as held, and ordinary statuses are not', () => {
    expect(isHeldForReviewPaymentStatus(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS)).toBe(true)
    for (const other of ['pending', 'paid', 'cancelled', 'cash_pending', 'failed', 'terminal_pending']) {
      expect(isHeldForReviewPaymentStatus(other)).toBe(false)
    }
  })

  it('is distinguishable from "not yet swept" — the whole point of the ruling', () => {
    // The sweep's candidate filter is payment_status = 'pending'. A held order must NOT match
    // it, or it is re-held every two minutes; and it must not BE 'pending', or it is
    // indistinguishable from an order the sweep has not reached. Both are the same assertion.
    expect(AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS).not.toBe('pending')
  })

  it('every other OWES_MONEY member except the hold and mid-flight stays cash-settleable', () => {
    // Control: the exclusion is surgical. Widening it would silently remove staff's ability to
    // take cash for cash_pending or failed orders, which is a real regression with no symptom
    // until someone tries.
    expect(isCashSettleablePaymentStatus('cash_pending')).toBe(true)
    expect(isCashSettleablePaymentStatus('failed')).toBe(true)
    expect(isCashSettleablePaymentStatus('pending')).toBe(true)
    expect(isCashSettleablePaymentStatus('terminal_pending')).toBe(false) // mid-flight, unchanged
  })
})
