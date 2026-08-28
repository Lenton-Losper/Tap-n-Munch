/**
 * The split of `stranded_pending` into two causes with opposite risk profiles.
 *
 * One cause was carrying both "a card was presented and we cannot tell what happened" and "no
 * payment was ever started", and its signed sentence — "The card machine reported a problem" — is
 * false for the second. On Riviera's board five of seven held orders had never touched a card
 * machine, and the override refused all five with "there is nothing to re-check against", which
 * presented the SAFEST orders as the only unclearable ones.
 *
 * PROOF CEILING: classification only. That the override then takes the right path for each cause
 * is proven in override-cancel-refuses-paid.
 */
import {
  NEVER_ATTEMPTED_CAUSE,
  STRANDED_PENDING_CAUSE,
  heldForReviewCause,
  isSignedCopyCause,
  neverAttemptedPayment,
  heldForReviewCopy,
  type HeldForReviewCandidate,
} from '@/lib/orders/held-for-review'

const THREE_HOURS_AGO = new Date(Date.now() - 3 * 3_600_000).toISOString()

function order(over: Partial<HeldForReviewCandidate> = {}): HeldForReviewCandidate {
  return {
    id: 'o1',
    payment_status: 'pending',
    status: 'pending',
    total: 100,
    placed_at: THREE_HOURS_AGO,
    paycloud_merchant_order_no: null,
    payment_attempt_started_at: null,
    ...over,
  }
}

describe('neverAttemptedPayment — the guard, and it is conjunctive', () => {
  it('true only when BOTH the reference and the attempt timestamp are absent', () => {
    expect(neverAttemptedPayment(order())).toBe(true)
  })

  it.each([
    ['a merchant order number', { paycloud_merchant_order_no: 'FT17878402258847650' }],
    ['an attempt timestamp', { payment_attempt_started_at: THREE_HOURS_AGO }],
    ['both', { paycloud_merchant_order_no: 'FT1', payment_attempt_started_at: THREE_HOURS_AGO }],
  ])('false when the order carries %s', (_label, over) => {
    expect(neverAttemptedPayment(order(over))).toBe(false)
  })

  it('treats whitespace as absent, because a blank string is not a reference', () => {
    expect(neverAttemptedPayment(order({ paycloud_merchant_order_no: '   ' }))).toBe(true)
  })
})

describe('heldForReviewCause — which cause a held order gets', () => {
  it("Riviera's shape — placed, never paid, no terminal — is the never-attempted cause", () => {
    expect(heldForReviewCause(order())).toBe(NEVER_ATTEMPTED_CAUSE)
  })

  it('an order that reached the gateway keeps the ORIGINAL cause and its signed copy', () => {
    const attempted = order({
      paycloud_merchant_order_no: 'FT17878402258847650',
      payment_attempt_started_at: THREE_HOURS_AGO,
    })
    expect(heldForReviewCause(attempted)).toBe(STRANDED_PENDING_CAUSE)
    expect(heldForReviewCopy(STRANDED_PENDING_CAUSE).why).toContain('The card machine reported a problem')
  })

  it('an attempt timestamp ALONE is enough to keep it off the light cause', () => {
    expect(heldForReviewCause(order({ payment_attempt_started_at: THREE_HOURS_AGO }))).toBe(
      STRANDED_PENDING_CAUSE,
    )
  })

  it('a reference ALONE is enough too', () => {
    expect(heldForReviewCause(order({ paycloud_merchant_order_no: 'FT1' }))).toBe(
      STRANDED_PENDING_CAUSE,
    )
  })

  /** The split must not drag anything new onto the board, or resolve anything off it. */
  it('changes nothing about WHETHER an order is held', () => {
    // Paid and cancelled still leave, at any age.
    expect(heldForReviewCause(order({ payment_status: 'paid' }))).toBeNull()
    expect(heldForReviewCause(order({ status: 'cancelled' }))).toBeNull()
    // Too recent still does not appear.
    expect(heldForReviewCause(order({ placed_at: new Date().toISOString() }))).toBeNull()
  })
})

describe('the new cause renders as prose, not as a marker', () => {
  /**
   * It is in the signed map so the board shows a sentence rather than `COPY NOT SIGNED`. The
   * wording was written by the implementer and is NOT owner-signed — see the note at the map
   * entry. This test asserts it renders; it deliberately does NOT pin the words, because pinning
   * unsigned wording character-for-character would make a later correction look like a regression.
   */
  it('has copy, and says nothing was taken and no checking is needed', () => {
    expect(isSignedCopyCause(NEVER_ATTEMPTED_CAUSE)).toBe(true)
    const copy = heldForReviewCopy(NEVER_ATTEMPTED_CAUSE)
    expect(copy.why).not.toMatch(/COPY NOT SIGNED|PENDING COPY/i)
    expect(copy.why).toContain('no payment was ever started')
    expect(copy.why).toContain('nothing was taken')
  })

  /**
   * The two sentences must never converge. One sends staff to the card machine before acting; the
   * other tells them they may act without checking anything. A reword that blurs them hands back
   * the guess the split exists to remove.
   */
  it('does NOT tell staff the card machine reported a problem', () => {
    expect(heldForReviewCopy(NEVER_ATTEMPTED_CAUSE).why).not.toContain('card machine reported')
  })
})
