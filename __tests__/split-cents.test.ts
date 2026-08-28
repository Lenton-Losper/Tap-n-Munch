/**
 * lib/billing/split-cents.ts -- the load-bearing arithmetic for item-level bill splitting.
 * "Prove the arithmetic cannot round its way to paid": every test here sums the ACTUAL returned
 * shares and asserts the sum is EXACTLY the input total, in integer cents, for adversarial
 * inputs chosen specifically because they do not divide evenly. No test in this file passes
 * because "close enough" -- every assertion is `===`.
 */
import {
  splitCentsByWeight,
  splitCentsEvenly,
  toCents,
  fromCents,
  sumCents,
  isFullyPaidCents,
  type CentsSplitShare,
} from '@/lib/billing/split-cents'

describe('splitCentsByWeight -- exact reconstruction', () => {
  it('100 cents split three ways evenly: 34/33/33, sums to exactly 100, no share dropped', () => {
    const result = splitCentsEvenly(100, ['sam', 'priya', 'jordan'])
    expect(sumCents(result.map((r) => r.amountCents))).toBe(100)
    // Largest-remainder gives the leftover cent to the first tied share (deterministic).
    expect(result.map((r) => r.amountCents)).toEqual([34, 33, 33])
  })

  it('1 cent split three ways: one share gets it, the other two get nothing -- still sums exactly', () => {
    const result = splitCentsEvenly(1, ['a', 'b', 'c'])
    expect(sumCents(result.map((r) => r.amountCents))).toBe(1)
    expect(result.filter((r) => r.amountCents > 0)).toHaveLength(1)
  })

  it('0 cents split N ways: every share is 0, sums to 0', () => {
    const result = splitCentsEvenly(0, ['a', 'b', 'c', 'd'])
    expect(sumCents(result.map((r) => r.amountCents))).toBe(0)
    expect(result.every((r) => r.amountCents === 0)).toBe(true)
  })

  it('an amount that does not divide evenly by a large N still sums exactly', () => {
    // 10007 cents across 7 shares: 10007 / 7 = 1429.571...
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const result = splitCentsEvenly(10007, keys)
    expect(sumCents(result.map((r) => r.amountCents))).toBe(10007)
    // Every share is within one cent of the mean -- largest-remainder's own guarantee.
    const floor = Math.floor(10007 / 7)
    for (const r of result) {
      expect(r.amountCents === floor || r.amountCents === floor + 1).toBe(true)
    }
  })

  it('adversarial weighted split: two people share one pizza 1/3 vs 2/3 of an odd total', () => {
    // R199.99 pizza -> 19999 cents, split 1:2 by quantity_allocated (0.5 vs 1.0, say).
    const result = splitCentsByWeight(19999, [
      { key: 'sam', weight: 1 },
      { key: 'priya', weight: 2 },
    ])
    expect(sumCents(result.map((r) => r.amountCents))).toBe(19999)
    expect(result.map((r) => r.amountCents)).toEqual([6666, 13333])
  })

  it('a genuinely non-exact weighted split still sums exactly (remainder path exercised)', () => {
    // 10000 cents, weights 1:1:1 -> 3333.33 each -> floors 3333*3=9999, leftover 1.
    const result = splitCentsByWeight(10000, [
      { key: 'a', weight: 1 },
      { key: 'b', weight: 1 },
      { key: 'c', weight: 1 },
    ])
    expect(sumCents(result.map((r) => r.amountCents))).toBe(10000)
    expect(result.map((r) => r.amountCents).sort((x, y) => y - x)).toEqual([3334, 3333, 3333])
  })

  it('many random-ish adversarial totals and share counts all reconstruct exactly', () => {
    // Deterministic pseudo-random sweep, not Math.random(), so a failure is reproducible.
    let seed = 12345
    const nextInt = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % max
    }

    for (let trial = 0; trial < 500; trial += 1) {
      const totalCents = nextInt(1_000_000) // up to R10,000.00
      const shareCount = 2 + nextInt(9) // 2..10 shares
      const shares: CentsSplitShare[] = Array.from({ length: shareCount }, (_, i) => ({
        key: `share-${i}`,
        weight: 1 + nextInt(5), // 1..5, uneven weights
      }))

      const result = splitCentsByWeight(totalCents, shares)
      const sum = sumCents(result.map((r) => r.amountCents))
      expect(sum).toBe(totalCents)
      // No share may be negative.
      expect(result.every((r) => r.amountCents >= 0)).toBe(true)
    }
  })

  it('a zero-weight share receives exactly zero, the rest still sum to the full total', () => {
    const result = splitCentsByWeight(1000, [
      { key: 'paying', weight: 1 },
      { key: 'not-paying-anything', weight: 0 },
    ])
    const zeroShare = result.find((r) => r.key === 'not-paying-anything')!
    expect(zeroShare.amountCents).toBe(0)
    expect(sumCents(result.map((r) => r.amountCents))).toBe(1000)
  })

  it('refuses a non-integer total rather than silently rounding it', () => {
    expect(() => splitCentsEvenly(100.5, ['a', 'b'])).toThrow(/integer/)
  })

  it('refuses an empty share list', () => {
    expect(() => splitCentsByWeight(100, [])).toThrow(/at least one share/)
  })

  it('refuses when every weight is zero (nothing to proportion by)', () => {
    expect(() =>
      splitCentsByWeight(100, [
        { key: 'a', weight: 0 },
        { key: 'b', weight: 0 },
      ]),
    ).toThrow(/sum of weights/)
  })

  it('refuses a negative weight', () => {
    expect(() => splitCentsByWeight(100, [{ key: 'a', weight: -1 }])).toThrow(/weight/)
  })
})

describe('toCents / fromCents round-trip', () => {
  it('19999 cents round-trips through fromCents/toCents unchanged', () => {
    expect(toCents(fromCents(19999))).toBe(19999)
  })

  it('a classic float-unsafe sum, converted once at the boundary, is exact', () => {
    // 35.10 + 27.25 + 42.95 === 105.30000000000001 in raw JS float arithmetic (payment-
    // integrity.ts's own documented example). Converting to cents FIRST, then summing integers,
    // avoids the artefact entirely.
    const cents = [toCents(35.1), toCents(27.25), toCents(42.95)]
    expect(sumCents(cents)).toBe(10530)
  })
})

describe('isFullyPaidCents -- exact equality only', () => {
  it('is true only when paid exactly equals total', () => {
    expect(isFullyPaidCents(10000, 10000)).toBe(true)
  })

  it('is false for one cent under, however the shortfall arose', () => {
    expect(isFullyPaidCents(9999, 10000)).toBe(false)
  })

  it('is false for one cent over -- overpayment is not silently "paid", it is a distinct anomaly', () => {
    expect(isFullyPaidCents(10001, 10000)).toBe(false)
  })

  it('a three-way split of 100 cents (34/33/33), paid in three separate passes, is fully paid only after the third', () => {
    const shares = splitCentsEvenly(100, ['sam', 'priya', 'jordan']).map((r) => r.amountCents)
    let paid = 0
    expect(isFullyPaidCents(paid, 100)).toBe(false)
    paid += shares[0]
    expect(isFullyPaidCents(paid, 100)).toBe(false)
    paid += shares[1]
    expect(isFullyPaidCents(paid, 100)).toBe(false)
    paid += shares[2]
    expect(isFullyPaidCents(paid, 100)).toBe(true)
  })
})
