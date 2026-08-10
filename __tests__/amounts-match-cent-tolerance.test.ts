/**
 * #180 — amountsMatch must accept a one-cent difference at EVERY amount, not most of them.
 *
 * The comparison was `Math.abs(a - b) <= 0.01` on doubles. Neither operand nor the literal
 * 0.01 is exactly representable, so whether a genuine one-cent gap lands on the accepting
 * side is an artefact of binary representation rather than anything about the payment:
 *
 *   78.36 - 78.35 === 0.010000000000005116   -> rejected
 *   20.01 - 20.00 === 0.010000000000001563   -> rejected
 *    0.04 -  0.03 === 0.010000000000000002   -> rejected
 *
 * Measured across every one-cent pair from NAD 10.00 to 500.00, 28.5% were refused. The
 * consequence is not academic: at the two hard-rejecting call sites the card has ALREADY been
 * charged when the 400 comes back, so the money moves and the order stays unpaid.
 *
 * Same convention as 10cf29c ("compare ledger amounts in integer cents") — whole cents as
 * integers, tolerance expressed as a cent count, so the question of representability does not
 * arise. The tolerance is ONE cent, not zero: a real rounding difference must not take the
 * money and then refuse the order.
 *
 * The two-cent cases are the other half of the pin. Without them, "fixing" this by widening
 * the float tolerance to something huge would pass every one-cent assertion and the suite
 * would be pinning nothing at all.
 */
import { amountsMatch } from '@/lib/payments/payment-integrity'

/** Whole-cent integer, used only to BUILD fixtures — never to implement the assertion. */
const nad = (cents: number) => cents / 100

describe('amountsMatch — a one-cent difference is always within tolerance', () => {
  it('accepts an exact one-cent difference at every 2dp amount from NAD 10.00 to 60.00', () => {
    const rejected: Array<{ a: number; b: number; floatDiff: number }> = []

    for (let cents = 1000; cents <= 6000; cents++) {
      const expected = nad(cents)
      const oneCentHigh = nad(cents + 1)
      const oneCentLow = nad(cents - 1)

      if (!amountsMatch(oneCentHigh, expected)) {
        rejected.push({ a: oneCentHigh, b: expected, floatDiff: Math.abs(oneCentHigh - expected) })
      }
      if (!amountsMatch(oneCentLow, expected)) {
        rejected.push({ a: oneCentLow, b: expected, floatDiff: Math.abs(oneCentLow - expected) })
      }
    }

    // Named explicitly so a failure reports HOW MANY and shows the first few, rather than
    // just "expected false to be true" on whichever amount happened to be first.
    expect({
      rejectedCount: rejected.length,
      firstFive: rejected.slice(0, 5),
    }).toEqual({ rejectedCount: 0, firstFive: [] })
  })

  it('is symmetric — argument order never changes the answer', () => {
    // There is no evidence the drift is directional, so the comparison must not invent one.
    for (let cents = 1000; cents <= 2000; cents++) {
      const expected = nad(cents)
      const high = nad(cents + 1)
      expect(amountsMatch(high, expected)).toBe(amountsMatch(expected, high))
    }
  })

  describe('the specific pairs reported on #180', () => {
    // Each of these is EXACTLY one cent apart and was refused by the float comparison.
    it.each([
      [78.36, 78.35],
      [20.01, 20.0],
      [0.04, 0.03],
    ])('accepts %p vs %p', (client, expected) => {
      expect(amountsMatch(client, expected)).toBe(true)
      expect(amountsMatch(expected, client)).toBe(true)
    })
  })
})

describe('amountsMatch — two cents is still a mismatch', () => {
  it('rejects an exact two-cent difference at every 2dp amount from NAD 10.00 to 60.00', () => {
    const accepted: Array<{ a: number; b: number }> = []

    for (let cents = 1000; cents <= 6000; cents++) {
      const expected = nad(cents)
      const twoCentHigh = nad(cents + 2)
      const twoCentLow = nad(cents - 2)

      if (amountsMatch(twoCentHigh, expected)) accepted.push({ a: twoCentHigh, b: expected })
      if (amountsMatch(twoCentLow, expected)) accepted.push({ a: twoCentLow, b: expected })
    }

    expect({ acceptedCount: accepted.length, firstFive: accepted.slice(0, 5) }).toEqual({
      acceptedCount: 0,
      firstFive: [],
    })
  })

  it.each([
    [78.37, 78.35],
    [20.02, 20.0],
    [0.05, 0.03],
  ])('rejects %p vs %p', (client, expected) => {
    expect(amountsMatch(client, expected)).toBe(false)
  })
})

describe('amountsMatch — non-finite input is never a match', () => {
  it.each([
    [NaN, 25],
    [25, NaN],
    [Infinity, 25],
    [25, -Infinity],
  ])('rejects %p vs %p', (a, b) => {
    expect(amountsMatch(a, b)).toBe(false)
  })
})

describe('the tolerance is one cent, expressed in cents', () => {
  // Pinned by BEHAVIOUR rather than by asserting on a constant's value: the one-cent and
  // two-cent suites above already fix the width exactly, and the third argument being
  // cent-denominated is what the zero-tolerance case below establishes.
  it('honours an explicit zero-cent tolerance', () => {
    expect(amountsMatch(20.01, 20.0, 0)).toBe(false)
    expect(amountsMatch(20.0, 20.0, 0)).toBe(true)
  })

  it('treats a float sum artefact as equal, not as a difference', () => {
    // The settle route sums order totals in floating point, so expectedAmount can arrive as
    // 105.30000000000001 for a tab whose real total is 105.30.
    const floatSum = 35.1 + 27.25 + 42.95
    expect(floatSum).not.toBe(105.3)
    expect(amountsMatch(105.3, floatSum, 0)).toBe(true)
  })
})
