/**
 * WHAT A TAB STILL OWES — with part-paid orders counted honestly.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO FIX
 * ==================================================================================================
 *
 * `unpaid_total` was the sum of whole UNPAID ORDERS' totals. That is order-grained, and settlement
 * stopped being order-grained the moment items could be paid for individually.
 *
 * So on a P5 at Digi Cofee, 2026-09-09: a N$34 tab, the N$6 cheese toast paid by card through the
 * item path. That settles an ALLOCATION; the order is not fully paid, so it stays unpaid, so its
 * FULL N$34 kept counting. The header went on reading NAD 34.00 with N$28 actually owed.
 *
 * Worse than a cosmetic error: a waiter reads that number to tell a customer what is left, and the
 * customer has already paid part of it.
 *
 * ==================================================================================================
 * THE SETTLED PART IS SUBTRACTED, AND ONLY FOR ORDERS STILL COUNTED
 * ==================================================================================================
 *
 * A fully-paid order is already excluded by `owesMoney`, so subtracting its settlements as well
 * would count them twice and drive the total negative. Settlements are therefore only subtracted
 * for orders that are still in the unpaid set.
 *
 * It clamps at zero. A tab cannot owe less than nothing, and a negative headline is a worse lie
 * than a stale one.
 */

export type OutstandingOrder = {
  id: string
  total: unknown
  /** Cents already settled against THIS order's items, from order_line_allocation_settlements. */
  settledCents?: number
}

/** Cents, so the arithmetic is integer and a repeating fraction cannot drift the headline. */
export function outstandingCentsFor(orders: OutstandingOrder[]): number {
  /**
   * NaN IS COERCED TO ZERO, NOT PROPAGATED, and it takes an explicit guard.
   *
   * `Math.max(0, NaN)` is NaN and `NaN ?? 0` is NaN -- `??` only catches null and undefined -- so a
   * single unparseable figure turned the whole tab headline into NaN. Caught by this file's own
   * "a missing or unparseable settled figure subtracts nothing" case, which was written for the
   * failed-read path and found a real defect in the arithmetic instead.
   */
  const finiteOrZero = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  let cents = 0
  for (const order of orders ?? []) {
    const totalCents = Math.round(finiteOrZero(order.total) * 100)
    const settled = Math.max(0, Math.round(finiteOrZero(order.settledCents)))
    /**
     * PER ORDER, not on the sum. Clamping only at the end would let one over-settled order silently
     * absorb another order's genuine debt — the tab would read as owing less than it does, which is
     * the direction that loses money.
     */
    cents += Math.max(0, totalCents - settled)
  }
  return cents
}

/** Major units, for the field the terminal renders. */
export function outstandingTotalFor(orders: OutstandingOrder[]): number {
  return outstandingCentsFor(orders) / 100
}
