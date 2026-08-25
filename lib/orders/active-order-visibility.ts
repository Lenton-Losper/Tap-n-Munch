/**
 * Which of a customer's orders are still "live" — the single source of truth for the landing-page
 * ActiveOrderBanner, the menu status tracker, and the useActiveOrders polling hook.
 *
 * These three had three different lists. The banner's omitted `waiting_review`, so a QR order
 * awaiting staff Accept showed nothing on the landing page (issue #132); all three omitted
 * `preparing` and `confirmed`, which are written by the dashboard and the terminal respectively
 * (see issue #131), so an order in either state silently vanished mid-meal.
 *
 * This decides only what the customer is SHOWN. It sets and transitions nothing.
 */

/**
 * Statuses an order can hold while it is still the customer's current order.
 *
 * `accepting` is the transient lock order_requests takes during Accept
 * (app/api/order-requests/[requestId]/accept/route.ts). It is included deliberately: callers
 * treat "not eligible" as "this order is over" and clear the stored order id, so a poll landing
 * inside that window would otherwise wipe the customer's order view for good.
 */
export const ACTIVE_ORDER_STATUSES = [
  'waiting_review',
  'accepting',
  'pending',
  'accepted',
  'confirmed',
  'preparing',
  'ready',
  'ready_for_terminal',
] as const

/** Statuses that end an order. Checked first so a closed order can never be shown as live. */
const TERMINAL_ORDER_STATUSES = ['completed', 'cancelled', 'declined'] as const

/**
 * Collapse the writers' vocabularies into the one the customer-facing renderers switch on.
 *
 * Anything that makes a status VISIBLE must run it through here, because a renderer that has
 * never heard of a status does not fail loudly -- it silently draws the order as less far along
 * than it is. That is exactly what happened when `confirmed` and `accepting` were added to
 * ACTIVE_ORDER_STATUSES without teaching buildTrackerSteps about them.
 *
 *  - `confirmed` is the terminal's word for `accepted`. The two transition tables put them in
 *    the same slot -- terminal `pending -> confirmed -> preparing`
 *    (app/api/terminal/orders/[orderId]/status/route.ts:23) against dashboard
 *    `pending -> accepted -> preparing` (lib/orders/status-transitions.ts:27).
 *  - `accepting` is the transient claim Accept takes on order_requests before the order row
 *    exists, and is rolled BACK to `waiting_review` if createOrder() throws
 *    (app/api/order-requests/[requestId]/accept/route.ts:66,119). Until it resolves, nothing
 *    has been accepted, so it must read as `waiting_review` and never as review-complete.
 */
export function normalizeOrderStatusForDisplay(status: unknown): string {
  const s = String(status || '').toLowerCase()
  if (s === 'confirmed') return 'accepted'
  if (s === 'accepting') return 'waiting_review'
  return s
}

/**
 * A status that ENDS the order, asked on its own.
 *
 * Distinct from `!isActiveOrderStatus(...)`, and the difference matters wherever the answer gates
 * an action rather than a render. `isActiveOrderStatus` is false for two very different things:
 * a status that ended the order, and a status nothing here has ever heard of. A renderer is right
 * to treat both as "do not show". A guard is not — refusing an action because the vocabulary grew
 * is how a working path breaks on a status someone added elsewhere.
 *
 * So: ask THIS when you need "is it over", and `isActiveOrderStatus` when you need "should it be
 * on screen".
 */
export function isTerminalOrderStatus(status: unknown): boolean {
  const s = String(status || '').toLowerCase()
  return (TERMINAL_ORDER_STATUSES as readonly string[]).includes(s)
}

export function isActiveOrderStatus(status: unknown): boolean {
  const s = String(status || '').toLowerCase()
  if (isTerminalOrderStatus(s)) return false
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(s)
}

/**
 * True when this order should still be shown to the customer.
 * A closed order or a closed table is never shown, whatever its status says.
 */
export function isBannerEligibleOrder(order: Record<string, any> | null | undefined): boolean {
  if (!order) return false
  if (order.is_closed === true || order.table_closed === true) return false
  return isActiveOrderStatus(order.status)
}

/**
 * When an order was placed, in epoch milliseconds, for choosing between two candidate orders.
 *
 * WRITTEN 2026-08-24, LATE. `ActiveOrderBanner` has imported and CALLED this since 838189b
 * ("whichever order is NEWER, not whichever is remembered") and it was never defined. Three layers
 * missed it and it is worth naming which, because the combination is the lesson:
 *
 *   tsc      ActiveOrderBanner.tsx carries `@ts-nocheck`, so the compiler never looked at it.
 *   jest     a named import that does not exist transpiles to `undefined` rather than throwing at
 *            require time, and no test exercises the branch that calls it -- so 211 suites passed.
 *   review   the import sat on its own line, away from the grouped import above it.
 *
 * Only the Next bundler resolves named exports statically, so only the BUILD caught it, and it has
 * failed every staging deploy since. The saving grace is that a failing build never shipped: the
 * banner would have thrown `orderPlacedAtMs is not a function` in exactly the stale-pointer case
 * the fix was written for -- worse than the defect it replaced.
 *
 * `placed_at` is the canonical column; `created_at` is what the guest projection carries for an
 * `order_requests` row, which has no `placed_at`. Comparing one of each is the normal case on a
 * table where a request is still in review.
 *
 * UNKNOWN SORTS OLDEST, deliberately. A row with no usable timestamp returns 0, so it can never
 * beat a row that has one -- the stored pointer only wins when it is provably newer, which is the
 * whole point of comparing rather than trusting it.
 */
export function orderPlacedAtMs(order: Record<string, any> | null | undefined): number {
  if (!order) return 0
  const raw = order.placed_at ?? order.created_at ?? null
  if (!raw) return 0
  const ms = new Date(String(raw)).getTime()
  return Number.isFinite(ms) ? ms : 0
}
