/**
 * WHAT A WHOLE-ORDER SETTLE IS WORTH, ON THE DEVICE.
 *
 * ==================================================================================================
 * WHY THE DEVICE HAD TO LEARN THIS
 * ==================================================================================================
 *
 * The server moved its whole-order charge basis to the OUTSTANDING amount: order total minus what
 * has already been collected through the item ledger. The device did not follow. It summed
 * `order.total`, which was the only basis in existence when it was written.
 *
 * On a part-paid order the two then disagree, and the order of operations makes that dangerous
 * rather than merely wrong:
 *
 *   1. prepare-payment charges the reader the correct outstanding amount.  MONEY MOVES.
 *   2. the device reports success and calls /settle with the old whole-total figure.
 *   3. the server's cross-check refuses it.
 *
 * A real charge with no settlement recorded against it. On the cash path it is less severe and
 * still wrong: a legitimate collection blocked at the till.
 *
 * ==================================================================================================
 * THE SAME INVARIANT, DERIVED FROM THE SAME FACTS
 * ==================================================================================================
 *
 * The server computes `max(0, total - settled)` per order from order_line_allocation_settlements.
 * The device computes the same figure from the SAME allocations, delivered per line by the tab
 * lines API and already reduced to `outstandingCents` by payableLines -- which is what the tab
 * header has displayed all along. So the number a waiter reads, the number the reader is asked
 * for, and the number sent to /settle become one number.
 *
 * ==================================================================================================
 * NO LINES MEANS NO SPLIT, WHICH MEANS THE TOTAL IS ALREADY RIGHT
 * ==================================================================================================
 *
 * An allocation exists only against a line. A tab the server cannot describe line by line
 * (`has_lines: false`, every order that predates splitting) therefore cannot have been part-paid,
 * and its total IS its outstanding amount. That is the fallback, and it is why this change is inert
 * for almost every settle on production rather than a new behaviour for all of them.
 *
 * THE GRATUITY IS NOT HERE. It rides alongside the bill and is added exactly once, by the server,
 * in prepare-payment. A tip must never reach this figure -- /settle records what the ITEMS were
 * worth, and payment_tips records the rest.
 */

/** Just enough of an order to price it. */
export interface SettleableOrderLike {
  id: string;
  total: number;
}

/** Just enough of a payable line: which order it belongs to, and what it still owes. */
export interface OutstandingLineLike {
  orderId: string;
  outstandingCents: number;
}

const finiteOrZero = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What this ONE order still owes, in integer cents.
 *
 * Clamped at zero per order, mirroring the server's chargeableCentsFor: clamping only on a sum
 * would let one over-settled order silently absorb another's genuine debt, and the tab would be
 * charged less than it is owed.
 */
export function outstandingCentsForOrder(
  order: SettleableOrderLike,
  lines?: readonly OutstandingLineLike[],
): number {
  const totalCents = Math.max(0, Math.round(finiteOrZero(order?.total) * 100));
  if (!lines) {
    return totalCents;
  }
  const own = lines.filter(line => line?.orderId === order?.id);
  if (own.length === 0) {
    // No line data for this order: nothing can have been allocated against it, so it owes its
    // total. Falling back to 0 here would silently stop collecting money.
    return totalCents;
  }
  const outstanding = own.reduce(
    (sum, line) => sum + Math.max(0, Math.round(finiteOrZero(line.outstandingCents))),
    0,
  );
  /**
   * NEVER MORE THAN THE ORDER'S OWN TOTAL. The line figures and the order total are two records of
   * the same money; if they ever disagreed upward, charging the larger one would take more than the
   * bill. The server clamps the same way.
   */
  return Math.max(0, Math.min(totalCents, outstanding));
}

/** What this SET of orders still owes, in major units, for the /settle amount field. */
export function settlementAmountFor(
  orders: readonly SettleableOrderLike[],
  lines?: readonly OutstandingLineLike[],
): number {
  /**
   * SUMMED IN CENTS AND DIVIDED ONCE. Adding major-unit figures accumulates float error -- the
   * shape that lands a settle on 78.35000000000001 and fails an exact-match gate.
   */
  const cents = (orders ?? []).reduce(
    (sum, order) => sum + outstandingCentsForOrder(order, lines),
    0,
  );
  return cents / 100;
}
