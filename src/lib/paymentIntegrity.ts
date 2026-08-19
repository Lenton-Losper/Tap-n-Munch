/**
 * Client-side mirror of the web repo's lib/payments/payment-integrity.ts —
 * keep these status sets in sync with that file. Used so the terminal never
 * sums or lets staff select an order the backend wouldn't accept as
 * claimable (e.g. cancelled, already paid) — the check has to happen before
 * a card is charged, not just when the backend later verifies the settle
 * request.
 *
 * #231: this file used to mirror only CLAIMABLE_PAYMENT_STATUSES, so any
 * "is this still owed" question on the terminal had to be hand-rolled
 * against payment_status directly — which is how #230 happened
 * (TablesScreen filtered `!== 'paid'`, so a cancelled order counted as
 * unpaid). The three sets below are ported verbatim from the web repo's
 * lib/payments/payment-integrity.ts (confirmed via
 * `git show ffa247bd8e9ae79b2d920f0f10e7a2c045920fd4:lib/payments/payment-integrity.ts`
 * against origin/main) so the terminal has the same three-way split the
 * server has, instead of only the narrowest one.
 */
function matchesStatusSet(status: unknown, set: readonly string[]): boolean {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  return set.includes(s);
}

export const CLAIMABLE_PAYMENT_STATUSES = ['unpaid', 'pending'] as const;

export function isClaimablePaymentStatus(status: unknown): boolean {
  return matchesStatusSet(status, CLAIMABLE_PAYMENT_STATUSES);
}

/** A card payment is currently in flight on the reader for this order. */
export const MID_FLIGHT_CARD_PAYMENT_STATUSES = ['terminal_pending'] as const;

export function isMidFlightCardPayment(status: unknown): boolean {
  return matchesStatusSet(status, MID_FLIGHT_CARD_PAYMENT_STATUSES);
}

/**
 * Statuses where the restaurant is still owed money. Deliberately wider than
 * CLAIMABLE_PAYMENT_STATUSES: a 'cash_pending', 'failed' or 'terminal_pending'
 * order has NOT been collected on, even though it isn't claimable for a NEW
 * card charge right now. Terminal states ('paid', 'cancelled') are absent by
 * design — this is the set TablesScreen's unpaid-count badge should use
 * (#230), since "N unpaid orders" is a debt count, not a claimability gate.
 */
export const OWES_MONEY_PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'cash_pending',
  'failed',
  'terminal_pending',
] as const;

export function owesMoney(status: unknown): boolean {
  return matchesStatusSet(status, OWES_MONEY_PAYMENT_STATUSES);
}

/**
 * Statuses a CASH settlement may claim: everything that still owes money
 * except a card payment that is currently in flight. Display/reasoning
 * mirror only — the actual settle action must keep gating on the server's
 * can_settle_cash (see TableDetailScreen), never re-derive that from
 * payment_status on the client.
 */
export const CASH_SETTLEABLE_PAYMENT_STATUSES = OWES_MONEY_PAYMENT_STATUSES.filter(
  status => !isMidFlightCardPayment(status),
) as readonly (typeof OWES_MONEY_PAYMENT_STATUSES)[number][];

export function isCashSettleablePaymentStatus(status: unknown): boolean {
  return matchesStatusSet(status, CASH_SETTLEABLE_PAYMENT_STATUSES);
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
