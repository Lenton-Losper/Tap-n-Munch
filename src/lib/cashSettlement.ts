/**
 * Which orders a cash settlement actually covers, and for how much.
 *
 * WHY THIS MODULE EXISTS. `cashSettlement.test.ts` was named after it and it did not exist: four of
 * its assertions ran against a local `selectCashSettleable` commented "Mirrors TableDetailScreen's
 * selection", while the real logic sat inline inside `runCashSettle`. The copy could not observe
 * the screen, so it proved only that the copy worked — the same defect `cashAttributionPicker` had.
 *
 * SERVER-DRIVEN, AND STRICTLY SO. Cash settleability is decided by the server and arrives as
 * `can_settle_cash`. It is never re-derived from `payment_status` here: the server owns the
 * settleable-status sets, and a second definition on the client is exactly how the two drift apart.
 * The `=== true` is deliberate — an older server response omits the field entirely, and `undefined`
 * must mean "not eligible" rather than being coerced to truthy by a loose check.
 *
 * THE AMOUNT COMES FROM THE SAME SET AS THE IDS, in one pass, so the two can never disagree.
 * Summing a different collection than the one being settled is how a terminal records a cash total
 * that does not match the orders it closed.
 */

/** Only the fields the selection depends on. */
export interface CashSettleableOrderLike {
  id: string;
  total: number;
  can_settle_cash?: boolean;
}

export interface CashSettleSelection {
  /** The orders the server will accept, in the order they were given. */
  orderIds: string[];
  /** The cash to record, summed from exactly those orders. */
  amount: number;
}

/**
 * Narrow `requestedOrderIds` to the ones the server says may be settled in cash, and total them.
 *
 * Returns an empty selection rather than throwing when nothing qualifies; the caller decides what
 * to tell the operator (see runCashSettle, which refuses on an empty set or a non-positive amount).
 */
export function selectCashSettleableOrders(
  orders: CashSettleableOrderLike[],
  requestedOrderIds: string[],
): CashSettleSelection {
  const eligible = orders.filter(
    order =>
      requestedOrderIds.includes(order.id) && order.can_settle_cash === true,
  );
  return {
    orderIds: eligible.map(order => order.id),
    amount: eligible.reduce((sum, order) => sum + order.total, 0),
  };
}
