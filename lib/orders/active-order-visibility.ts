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
 * Active statuses that sit BEFORE staff have taken the order on.
 *
 * `waiting_review` is a QR order queued for Accept; `accepting` is the transient lock Accept
 * takes and rolls back to `waiting_review` on failure. Nothing has been agreed to in either.
 */
export const PRE_ACCEPTANCE_ORDER_STATUSES = ['waiting_review', 'accepting'] as const

/**
 * Statuses from which an order LEAVING the active list means it was closed out -- served,
 * settled, done -- rather than turned away.
 *
 * Derived, not listed. OrderStatusBanner kept its own inline copy
 * (['accepted','preparing','ready','pending']) and it fell behind ACTIVE_ORDER_STATUSES by two:
 * `ready_for_terminal`, so an order that reached the card machine and was then paid and closed
 * told the customer nothing, and `confirmed`, the terminal's word for `accepted`. Subtracting
 * from the shared list means a status added to ACTIVE_ORDER_STATUSES later is covered by
 * default instead of silently dropped the way those two were.
 *
 * The subtraction is not symmetry-breaking pedantry: an order vanishing from `waiting_review`
 * or `accepting` has almost certainly been DECLINED, and "completed. Enjoy your meal!" over a
 * declined order is worse than saying nothing. Those two are named above and excluded here.
 */
export const IN_PROGRESS_ORDER_STATUSES = ACTIVE_ORDER_STATUSES.filter(
  (status) => !(PRE_ACCEPTANCE_ORDER_STATUSES as readonly string[]).includes(status),
)

/** True when a disappearance from the active list should read as "this order is finished". */
export function isInProgressOrderStatus(status: unknown): boolean {
  return IN_PROGRESS_ORDER_STATUSES.includes(
    String(status || '').toLowerCase() as (typeof IN_PROGRESS_ORDER_STATUSES)[number],
  )
}

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

export function isActiveOrderStatus(status: unknown): boolean {
  const s = String(status || '').toLowerCase()
  if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(s)) return false
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
