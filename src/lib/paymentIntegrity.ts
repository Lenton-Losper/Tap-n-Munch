/**
 * Client-side mirror of the web repo's lib/payments/payment-integrity.ts —
 * keep CLAIMABLE_PAYMENT_STATUSES in sync with that file. Used so the
 * terminal never sums or lets staff select an order the backend wouldn't
 * accept as claimable (e.g. cancelled, already paid) — the check has to
 * happen before a card is charged, not just when the backend later
 * verifies the settle request.
 */
export const CLAIMABLE_PAYMENT_STATUSES = ['unpaid', 'pending'] as const;

export function isClaimablePaymentStatus(status: unknown): boolean {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  return (CLAIMABLE_PAYMENT_STATUSES as readonly string[]).includes(s);
}

export interface ClaimableOrderLike {
  id: string;
  total: number;
  payment_status: string;
}

export interface ClaimableSettleSelection<T> {
  orderIds: string[];
  orders: T[];
  amount: number;
}

/**
 * Filters `orders` down to whichever of `orderIds` are actually claimable
 * right now, and sums their totals. `orderIds` and `amount` are always
 * derived from the same filtered set, so a caller can never end up charging
 * for orders it doesn't also forward to the backend (or vice versa).
 *
 * This is the single place that decides what reaches the card reader for a
 * tab settle — a cancelled/already-paid/refunded order can never contribute
 * to the amount or be included in the id list, even if a stale selection
 * (race with another staff member, a just-cancelled order) tries to pass
 * one in.
 */
export function selectClaimableOrdersForSettle<T extends ClaimableOrderLike>(
  orders: T[],
  orderIds: string[],
): ClaimableSettleSelection<T> {
  const claimable = orders.filter(
    order =>
      orderIds.includes(order.id) && isClaimablePaymentStatus(order.payment_status),
  );
  return {
    orderIds: claimable.map(order => order.id),
    orders: claimable,
    amount: claimable.reduce((sum, order) => sum + order.total, 0),
  };
}
