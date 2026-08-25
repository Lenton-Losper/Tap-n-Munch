/**
 * #121 — WHO MAY PRESS "Ready to Pay" ON A CASH ORDER, and who may not.
 *
 * ONE RULE, MEANT FOR TWO CALLERS. That is the point of this file existing rather than the
 * predicate living next to the button.
 *
 *   app/api/orders/[orderId]/ready-to-pay-cash/route.ts             decides whether to ALLOW it
 *   app/menu/[restaurantId]/order-confirmation/[orderId]/page.tsx   decides whether to SHOW it
 *
 * If those two drift, the customer gets the worst kind of failure: a button that is visible and
 * refuses. #121 is the mirror of that — a button that is visible, accepted, and does nothing —
 * and the fix that makes it real is exactly the moment to stop the other version being possible.
 *
 * BOTH IMPORT THIS. The page carried private copies of these predicates until the swap landed;
 * they are gone, and its call sites use the imported names directly so a grep for
 * `showCashReadyToPayButton` finds the screen as well as the route.
 *
 * The relocation was deliberately BYTE-FAITHFUL to the page's copy, with ONE difference, named
 * rather than hidden: `cashReadyToPayRefusal` adds a terminal-status check the page's copy never
 * had. It can only ever HIDE the button — on completed, cancelled and declined orders, where
 * pressing it did nothing anyway — never show it somewhere new.
 *
 * The route MUST NOT be a superset of the button. It is a service-role write, reachable by anyone
 * who can construct a POST, so every condition the button applies has to be re-applied on the
 * server. Sharing the function is how that is guaranteed instead of remembered.
 */
import { isTerminalOrderStatus } from './active-order-visibility'

/** The only fields either caller needs. Deliberately structural, so both row shapes satisfy it. */
export type CashReadyToPayOrder = {
  payment_channel?: string | null
  payment_method?: string | null
  payment_status?: string | null
  status?: string | null
  customer_ready_to_pay?: boolean | null
}

/**
 * Is this order settling in cash?
 *
 * THREE SIGNALS, ANY OF THEM. They are not redundant — they are written by different paths:
 *   payment_channel === 'cash'    the customer's own choice at checkout
 *   payment_method  === 'cash'    what the order was created with
 *   payment_status  === 'cash_pending'  written by app/api/orders/route.ts:163, and also by
 *                                 app/api/payments/cancel-terminal/route.ts:96 when a CARD
 *                                 attempt is abandoned and the order falls back to cash
 *
 * That last one is why `payment_method` alone is not enough: an order can become a cash order
 * after it was created as a card one.
 *
 * MOVED HERE VERBATIM from order-confirmation/[orderId]/page.tsx:97-103. Same three checks, same
 * order, no wording or logic changed — this is a relocation so the server can apply it, not a
 * redefinition.
 */
export function isCashPaymentOrder(order: CashReadyToPayOrder): boolean {
  const paymentStatus = String(order.payment_status || '').toLowerCase()
  return (
    String(order.payment_channel || '').toLowerCase() === 'cash' ||
    String(order.payment_method || '').toLowerCase() === 'cash' ||
    paymentStatus === 'cash_pending'
  )
}

/**
 * Why this order may NOT be flagged ready-to-pay. `null` means it may.
 *
 * A REASON RATHER THAN A BOOLEAN, because the route has to answer with something, and "no" with
 * no cause is how a support conversation becomes archaeology. These strings are diagnostic — they
 * are returned in an API error body, never rendered as customer prose.
 */
export function cashReadyToPayRefusal(order: CashReadyToPayOrder): string | null {
  if (!isCashPaymentOrder(order)) return 'not a cash order'

  const paymentStatus = String(order.payment_status || '').toLowerCase()
  if (paymentStatus === 'paid') return 'already paid'
  if (paymentStatus === 'cancelled') return 'payment cancelled'

  /**
   * The status check the button never had.
   *
   * `isTerminalOrderStatus`, not `!isActiveOrderStatus`: an unrecognised status must not refuse
   * a customer who is genuinely waiting to pay. Only completed / cancelled / declined do.
   *
   * In practice payment_status already covers most of these — nothing writes `status:'cancelled'`
   * without `payment_status:'cancelled'` beside it (lib/orders/cancel-order-with-trail.ts:89-90,
   * lib/orders/auto-cancel-stale-pos-orders.ts:188-189). It is here because "in practice" is a
   * statement about today's writers, and this gate outlives them.
   */
  if (isTerminalOrderStatus(order.status)) return 'order is closed'

  return null
}

/**
 * Should the "Ready to Pay" button be on screen?
 *
 * Eligible, and not already flagged. `== null` is deliberate and covers both `undefined` (the
 * field absent from a projection) and a genuine SQL NULL — the column defaults to `false` but
 * rows predating that default exist.
 */
export function showCashReadyToPayButton(order: CashReadyToPayOrder): boolean {
  return cashReadyToPayRefusal(order) === null && order.customer_ready_to_pay !== true
}

/**
 * Should the "staff have been told" confirmation be on screen instead?
 *
 * NOT the negation of the button. A paid cash order is neither: the button is gone because it is
 * paid, and the notice is gone because the meal is over. Only an order that is STILL a live cash
 * order and HAS been flagged shows it.
 */
export function showCashReadyToPayNotified(order: CashReadyToPayOrder): boolean {
  return isCashPaymentOrder(order) && order.customer_ready_to_pay === true
}
