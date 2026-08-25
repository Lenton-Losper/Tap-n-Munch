/**
 * #121 — THE CASH "Ready to Pay" BUTTON HAS NEVER WORKED. NOT ONCE, SINCE LAUNCH.
 *
 * MEASURED ON PRODUCTION 2026-08-25, read-only:
 *
 *     payment_method   orders   flagged customer_ready_to_pay
 *       cash              490        0
 *       (null)              5        0
 *
 * 490 cash orders. Zero ever flagged. The zero is not vacuous — the same query counts the flag
 * correctly for other paths, so the instrument works.
 *
 * WHY. `components/ready-to-pay-cash.tsx` wrote to `orders` with the BROWSER ANON CLIENT. The only
 * anon UPDATE policy on that table is
 *
 *     "Guest can mark order ready for terminal"  WITH CHECK (status = 'ready_for_terminal')
 *
 * and `WITH CHECK` is evaluated against the RESULTING row. A cash order's status is
 * pending / accepted / preparing / ready — never `ready_for_terminal`, because that is the CARD
 * flow's status and reaching it is what the card button's route does. So Postgres rejected every
 * press.
 *
 * THE FAILURE IS WORSE THAN AN ERROR MESSAGE, and this is why the route is written rather than
 * the policy widened. On staging the same press produced NO error at all: RLS filtered the row,
 * PostgREST reported success, `updateError` was null, and the component took its success path.
 * The customer was told staff had been notified when nothing had been recorded — invisible to
 * anyone watching error rates. Widening the policy would leave the write in the browser, where
 * the next policy change silently re-breaks it the same way.
 *
 * SO: the same shape as the card sibling, `/api/orders/[orderId]/ready-for-terminal`. A
 * service-role write behind an ownership check the server performs, and a response the client can
 * actually believe.
 *
 * ====================================================================================
 * WHAT THIS ROUTE DOES NOT DO
 * ====================================================================================
 *
 * IT DOES NOT TOUCH `status`, and that is the difference from the card route. `ready_for_terminal`
 * is a request for a card machine. A cash customer is not asking for one — they are telling staff
 * they want to settle. Only `customer_ready_to_pay` moves, which is exactly what
 * `components/orders-dashboard.tsx:146` reads to raise it on the staff board.
 *
 * IT DOES NOT REQUIRE A `tableNumber`, unlike the card route. That parameter is a CLAIM by the
 * client compared against the row, so it establishes only that the caller knows the table number —
 * which is printed on the QR code at the table. Both guards below bind to the order ROW instead,
 * which is strictly stronger, and it means this route needs nothing from the page that renders the
 * button.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireSessionToken } from '@/lib/session-guard'
import { ownsOrder } from '@/lib/guest-orders/validation'
import { cashReadyToPayRefusal } from '@/lib/orders/cash-ready-to-pay'

export async function POST(req: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  const trimmedOrderId = String(orderId || '').trim()
  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'Missing orderId' }, { status: 400 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  /**
   * EVERY id the browser holds, never one.
   *
   * The app mints two session ids in two storages and nothing syncs them — `flashtap_session_v1`
   * and `tab_session_id` — and an order carries whichever the placing screen happened to hold.
   * A check that knows only one answers "not yours" to the customer's own order. `ownsOrder` owns
   * that rule; this only has to pass it the whole list.
   */
  const claimedSessionIds = [
    ...(Array.isArray(body.session_ids) ? (body.session_ids as unknown[]) : []),
    ...(Array.isArray(body.sessionIds) ? (body.sessionIds as unknown[]) : []),
    body.session_id,
    body.sessionId,
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)

  const supabase = createServerSupabaseClient()
  const { data: order, error: loadError } = await supabase
    .from('orders')
    /**
     * ONE STRING LITERAL, not a concatenation, and the line length is the price of that.
     *
     * supabase-js parses this column list AT THE TYPE LEVEL to build the row type. Splitting it
     * with `+` defeats that parse: the row comes back as `GenericStringError` and every field
     * access below fails to compile. Caught by tsc rather than reasoned about — six errors, all
     * of them "Property does not exist on type 'GenericStringError'".
     */
    .select('id, restaurant_id, tab_id, session_id, member_session_id, status, payment_status, payment_method, payment_channel, customer_ready_to_pay')
    .eq('id', trimmedOrderId)
    .maybeSingle()

  if (loadError) {
    console.error('[ready-to-pay-cash] load failed', loadError)
    return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  /**
   * TWO WAYS TO OWN THIS ORDER, and a caller needs only one.
   *
   * GUARD 1, the dining session token. Preferred where it exists, because `validateSessionToken`
   * checks revocation, the 24h TTL and the table's `current_session_version` — so it stops being
   * valid the moment staff close the table, which a bare session id never does. Bound to the ROW:
   * the token's restaurant must be the order's, and if the order belongs to a tab, the token's tab
   * must be that tab.
   *
   * GUARD 2, the held session ids. The fallback for kiosk and non-tab guests, who have no token at
   * all. `ownsOrder` compares every held id against BOTH columns the placer can be recorded in.
   *
   * Neither is a credential — a session id is a bearer value the client supplies. What this
   * authorises is deliberately small: raising a flag that asks staff to come and take cash. It
   * moves no money, exposes no data, and is idempotent.
   */
  const guard = await requireSessionToken(req)
  let owned = false

  if (!guard.error) {
    const restaurantMatches =
      !guard.restaurantId || String(order.restaurant_id) === String(guard.restaurantId)
    const tabMatches = !order.tab_id || !guard.tabId || String(order.tab_id) === String(guard.tabId)
    owned = restaurantMatches && tabMatches
  }

  if (!owned) {
    owned = ownsOrder(order, claimedSessionIds)
  }

  if (!owned) {
    return NextResponse.json(
      { error: 'Session token or matching session_id required' },
      { status: 403 },
    )
  }

  /**
   * ALREADY FLAGGED IS A SUCCESS, NOT A CONFLICT.
   *
   * Checked BEFORE the refusal below, deliberately. A customer who pressed the button and then
   * paid would otherwise be told "already paid" for a press that had in fact worked — an error
   * about the very state their own earlier press produced. The flag is a one-way latch; re-raising
   * it is a no-op, so saying so is the honest answer.
   */
  if (order.customer_ready_to_pay === true) {
    return NextResponse.json({ success: true, orderId: trimmedOrderId, alreadyNotified: true })
  }

  /**
   * The eligibility rule, IMPORTED rather than restated.
   *
   * `lib/orders/cash-ready-to-pay.ts` is the same module the button's own visibility asks. A route
   * that re-implemented it would be a superset the moment either side changed, and this is a
   * service-role write reachable by anyone who can construct a POST.
   */
  const refusal = cashReadyToPayRefusal(order)
  if (refusal) {
    return NextResponse.json(
      { error: `Cannot mark ready to pay: ${refusal}` },
      { status: 409 },
    )
  }

  /**
   * `.eq('customer_ready_to_pay', false)` is NOT used as the guard here.
   *
   * The column defaults to false, but rows predating that default hold NULL, and PostgREST's `eq`
   * never matches NULL — so guarding on it would silently update zero rows for exactly the orders
   * most likely to need it, and `.select()` would then report a conflict that is not one. The
   * true-check above already provides the idempotency; this write is unconditional on that column
   * by design.
   */
  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({ customer_ready_to_pay: true })
    .eq('id', trimmedOrderId)
    .select('id')
    .maybeSingle()

  if (updateError) {
    console.error('[ready-to-pay-cash] update failed', updateError)
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
  if (!updated?.id) {
    // The row was loaded a moment ago, so this means it was deleted underneath us. Say so rather
    // than reporting a success the staff board will not show.
    return NextResponse.json({ error: 'Order is no longer available' }, { status: 409 })
  }

  return NextResponse.json({ success: true, orderId: trimmedOrderId, alreadyNotified: false })
}
