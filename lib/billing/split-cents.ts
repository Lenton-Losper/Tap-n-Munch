/**
 * Item-level bill splitting -- the arithmetic core, per docs/design-item-level-bill-splitting.md.
 *
 * "Financial records are append-only, a part-paid order is never rewritten, and an order is
 * fully paid only when every line is - prove the arithmetic cannot round its way to paid."
 *
 * ============================================================================================
 * WHY INTEGER CENTS, NEVER FLOATING MAJOR-UNIT AMOUNTS
 * ============================================================================================
 *
 * `lib/payments/payment-integrity.ts`'s own amountsMatch() already documents the reason: money
 * compared or summed as floating major-unit values (78.36 - 78.35) does not reproduce, because
 * neither operand nor the difference is exactly representable in binary. That module rounds to
 * cents only at the POINT OF COMPARISON. Splitting a total N ways is a different failure mode --
 * summing N *shares* has to reconstruct the *exact* original total, not just compare close to
 * it -- so every function here works in whole integer cents from end to end and refuses any
 * input that is not already an integer. There is no rounding step in this file to get wrong,
 * because there is no floating-point arithmetic on money in this file at all.
 *
 * ============================================================================================
 * THE METHOD: LARGEST REMAINDER (Hare quota)
 * ============================================================================================
 *
 * Splitting totalCents by weights [w0, w1, ...wn] naively as `totalCents * wi / sumW` produces
 * fractional cents that do not sum back to totalCents when floored independently -- e.g. 100
 * cents split three ways by equal weight floors to 33+33+33 = 99, one cent short every time.
 *
 * Each share is floor(totalCents * wi / sumW); the leftover (totalCents - sum of floors) is
 * always a whole number of cents strictly less than the number of shares, and is handed out one
 * cent at a time to the shares with the largest fractional remainder first (ties broken by
 * earliest index, so the same inputs always produce the same output -- this is an append-only
 * ledger; a split that could not be reproduced from its own inputs would be unauditable).
 *
 * This is the same algorithm used to apportion parliamentary seats by vote share for exactly
 * the same reason: it is the only integer allocation method that (a) sums to the total exactly
 * and (b) never gives a share less than its floor or more than its ceiling.
 */

export type CentsSplitShare = {
  /** Caller-supplied identifier for this share, carried through unchanged for traceability. */
  key: string
  /** Non-negative weight (e.g. quantity_allocated). Shares with weight 0 always receive 0. */
  weight: number
}

export type CentsSplitResult = {
  key: string
  weight: number
  amountCents: number
}

/**
 * Split `totalCents` across `shares` by weight so the resulting amounts sum to EXACTLY
 * `totalCents` -- no leftover cent silently dropped, none double-counted.
 *
 * Throws rather than silently coercing on anything that would make the guarantee above false:
 * a non-integer total, a negative or non-finite weight, an empty share list, or all-zero
 * weights (nothing to proportion by). Throwing here, before any row is written, is cheaper than
 * discovering a fractional-cent allocation after it has already been persisted.
 */
export function splitCentsByWeight(
  totalCents: number,
  shares: CentsSplitShare[],
): CentsSplitResult[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error(`totalCents must be a non-negative integer (whole cents), got ${totalCents}`)
  }
  if (shares.length === 0) {
    throw new Error('splitCentsByWeight: at least one share is required')
  }
  for (const share of shares) {
    if (!Number.isFinite(share.weight) || share.weight < 0) {
      throw new Error(`splitCentsByWeight: weight for "${share.key}" must be finite and >= 0, got ${share.weight}`)
    }
  }

  const sumWeights = shares.reduce((sum, s) => sum + s.weight, 0)
  if (sumWeights <= 0) {
    throw new Error('splitCentsByWeight: sum of weights must be > 0')
  }

  const raw = shares.map((s) => (totalCents * s.weight) / sumWeights)
  const floors = raw.map((r) => Math.floor(r))
  const distributed = floors.reduce((a, b) => a + b, 0)
  let leftover = totalCents - distributed

  // Deterministic: largest fractional remainder first, ties broken by input order.
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)

  const amounts = [...floors]
  for (let k = 0; k < order.length && leftover > 0; k += 1) {
    amounts[order[k].i] += 1
    leftover -= 1
  }

  // Self-check before returning. If this is ever false, the caller must not trust the result --
  // it must not be possible for a caller to receive shares that misreport their own sum.
  const finalSum = amounts.reduce((a, b) => a + b, 0)
  if (finalSum !== totalCents) {
    throw new Error(
      `splitCentsByWeight: internal invariant violated -- shares summed to ${finalSum}, expected ${totalCents}`,
    )
  }

  return shares.map((s, i) => ({ key: s.key, weight: s.weight, amountCents: amounts[i] }))
}

/** Convenience wrapper: split evenly N ways (equal weight per share). */
export function splitCentsEvenly(totalCents: number, keys: string[]): CentsSplitResult[] {
  return splitCentsByWeight(
    totalCents,
    keys.map((key) => ({ key, weight: 1 })),
  )
}

/** Convert a major-unit money value (already known to be cent-exact) to integer cents. */
export function toCents(majorUnits: number): number {
  if (!Number.isFinite(majorUnits)) {
    throw new Error(`toCents: not a finite number: ${majorUnits}`)
  }
  return Math.round(majorUnits * 100)
}

export function fromCents(cents: number): number {
  return cents / 100
}

export function sumCents(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/**
 * THE FULLY-PAID PREDICATE. Integer equality only -- no tolerance, no `<=`, no floating point.
 *
 * `paidCents` must equal `totalCents` exactly. Strictly less is "not yet fully paid" (the
 * correct, expected state of a partial split mid-service). Strictly greater must never be able
 * to reach this predicate at all -- the settlement path that accumulates `paidCents` is
 * required to refuse any write that would push the sum past `totalCents` (see
 * lib/orders/order-line-allocations.ts), so overpayment is prevented at the write, not
 * tolerated at the read. This predicate does not itself decide what "greater" means, on
 * purpose: silently treating an overpay as "paid" is exactly the kind of rounding-shaped
 * business-rule guess this feature was built to refuse to make.
 */
export function isFullyPaidCents(paidCents: number, totalCents: number): boolean {
  return paidCents === totalCents
}
