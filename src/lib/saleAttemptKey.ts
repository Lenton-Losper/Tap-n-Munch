/**
 * #328 — the idempotency key for one SALE ATTEMPT.
 *
 * WHAT IT IS FOR. A failed payment launch leaves the order at payment_status='pending'. Staff
 * retry. With no key the retry creates a BRAND NEW order and the first is stranded — and because
 * that stranded row carries a paycloud_merchant_order_no, the stale-order cron sends it to the
 * Finatic branch, is answered E04111, and skips it forever. So every retry permanently adds a row
 * that nothing will ever clean up. Confirmed duplicate-retry pairs at Mingle: #85 -> #86 (30s
 * apart, identical Americano) and #101 -> #102 (74s apart, identical item).
 *
 * THE SERVER SIDE ALREADY EXISTS and has for a long time — app/api/terminal/orders/route.ts reads
 * `x-idempotency-key`, lib/orders/create-order.ts stores it, and treats a 23505 unique violation as
 * "this order already exists" and returns the existing row rather than creating a duplicate.
 * Measured on production, all time: 0 of 1545 POS orders carried a key. The customer app has always
 * sent one. This is the one client that did not honour a contract its sibling already did.
 *
 * LIFETIME IS THE SALE, NOT THE REQUEST. The key must be STABLE across retries of the same sale and
 * NEW for a genuinely different one, so it is owned by CartContext and lives exactly as long as the
 * cart does: generated when the first item is rung up, held while the sale is on screen, and
 * dropped when the cart empties — on success, on abandonment, or when the operator starts another.
 *
 * COLLISION RESISTANCE. The server only compares equality, so any distinct string works. This uses
 * a millisecond timestamp (monotonic between sales on one device) plus 40 bits of randomness per
 * segment. Deliberately dependency-free: react-native has no crypto.randomUUID on either platform
 * without a polyfill, and adding one for a string comparison is not worth the install.
 */
const segment = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

export function newSaleAttemptKey(): string {
  return `pos_${Date.now().toString(36)}_${segment()}${segment()}`;
}
