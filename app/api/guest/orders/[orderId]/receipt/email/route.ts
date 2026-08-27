import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { guestCanReceiveOrderDelivery } from '@/lib/guest-orders/validation'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'
import type { GuestOrderRow } from '@/lib/guest-orders/types'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Guest-facing "email my receipt" -- no staff auth. Distinct from the staff route
 * (app/api/orders/[orderId]/receipt/email), which is behind requireStaffPermission.
 *
 * QRA-19: this used to gate on `guestCanAccessOrder`, which returns true for a PAID order on
 * restaurant scope ALONE -- and the restaurant uuid is in every menu URL. So the effective
 * requirement to have a stranger's itemised receipt mailed to an address of your choosing was
 * the order UUID and nothing else. It also forces `issueReceiptForOrder`, which ALLOCATES a
 * document number for an order that had no receipt yet.
 *
 * Now gated on `guestCanReceiveOrderDelivery`: restaurant, PLUS a session id the order was
 * actually placed under. See that function for why the read helper was left alone (#279 is a
 * recorded decision with a test pinning it) rather than tightened in place.
 *
 * #304 -- THE TABLE NUMBER IS NOT READ HERE, AND THAT IS THE FIX. QRA-19 left the gate admitting
 * on the table the order sits at, and a table number is printed on the QR code, appears in every
 * menu URL, and is a small integer. Proven on the deployed handler against an UNPAID order, so
 * nothing could be issued or mailed: correct table_number -> 400 "not paid yet" (past the gate),
 * any other table_number -> 404, restaurant scope alone -> 404. The table number alone was the
 * difference between a refusal and this restaurant mailing a stranger's itemised receipt to an
 * address the caller typed.
 *
 * #304 SECOND NARROWING -- THE RECIPIENT IS BOUND. The address is still typed by the caller on the
 * FIRST send, because there is nowhere else to get it: #234 established there is no
 * `customer_email` column and there is none at HEAD. But once this receipt has been delivered to an
 * address, that is the only address it may be delivered to (sendReceiptEmail GATE 3, opt-in, set
 * only by this route). That removes the attacker's CHOICE of recipient for every send after the
 * first, which is the property the issue names as the difference between exfiltration and nuisance.
 *
 * MEASURED ON PRODUCTION 2026-08-27, read-only, at deployed b270378a -- a dated measurement, not a
 * standing claim (Rule 20). Of 88 receipt_deliveries rows, 85 are PRINT and 3 are EMAIL. Those 3
 * span 3 distinct receipt documents and ONE distinct destination address, which is the developer's
 * own; no receipt has ever been emailed to more than one address, and 1807 of the 1810 receipt
 * documents have never been emailed at all. So the exfiltration signature is absent and this has
 * never been exercised against a customer -- which sets the urgency, not the correctness.
 *
 * RE-DERIVE IT rather than trusting the paragraph above: the PRINT and document totals move with
 * live traffic (they moved by 3 between two runs twenty minutes apart), and only the EMAIL figures
 * were stable. `scripts/measure-304-receipt-email-exposure.ts` is that measurement, read-only, and
 * it refuses to report a finding when its own controls fail -- because a query that reads nothing
 * produces the same "zero" as a clean result.
 *
 * STILL OPEN, AND OWED A RULING. This route takes NO session token, and requiring one would refuse
 * every legitimate caller today: the ONLY guest surface that calls it is
 * `app/menu/[restaurantId]/kiosk-success/page.tsx`, the kiosk flow holds no
 * `flashtap_session_token` (nothing under `app/menu/[restaurantId]/kiosk*` reads or writes that
 * key -- tokens are minted on the QR/tab flow in `v2/page.tsx`), and that page sends this request
 * with a bare `fetch`, not `fetchWithSession`. So #304 option A is not a drop-in; it needs the
 * kiosk flow bound to a tab, or a one-time signed delivery link. Neither is decided.
 *
 * The session id is read from BOTH `session_id` and repeated `session_id` params, because the
 * app mints two ids in different storages and an order carries whichever the placing screen
 * held -- checking one is the #278 class of bug.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const body = await req.json().catch(() => ({}))
  const email = typeof body?.email === 'string' ? body.email.trim() : ''

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: MENU_COPY.guestEmailInvalid }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const restaurantId =
    searchParams.get('restaurantId')?.trim() ||
    searchParams.get('restaurant_id')?.trim() ||
    (typeof body?.restaurantId === 'string' ? body.restaurantId.trim() : '') ||
    (typeof body?.restaurant_id === 'string' ? body.restaurant_id.trim() : '')
  // No table_number is parsed. #304: it is not an authority for a delivery, and reading it here
  // would only invite it back into the gate below.
  // getAll, not get: the client sends one repeated param per id it holds (see ownsOrder).
  const sessionIds = [
    ...searchParams.getAll('session_id'),
    ...(typeof body?.session_id === 'string' ? [body.session_id] : []),
    ...(Array.isArray(body?.session_ids) ? body.session_ids.map((v: unknown) => String(v ?? '')) : []),
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  const sessionId = sessionIds[0] ?? null

  if (!restaurantId) {
    return NextResponse.json({ error: MENU_COPY.somethingWentWrongAskStaff }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { data: order, error } = await supabase
    .from('orders')
    .select(
      'id, restaurant_id, table_number, session_id, member_session_id, is_closed, status, payment_status',
    )
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) {
      // The real reason goes HERE, never into the body: this route takes no session token.
      console.error('[guest/receipt/email] order lookup failed', { orderId, reason: error.message })
    return NextResponse.json({ error: MENU_COPY.somethingWentWrongAskStaff }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: MENU_COPY.guestOrderNotFound }, { status: 404 })
  }

  const guestOrder = { ...order, id: String(order.id) } as GuestOrderRow
  if (!guestCanReceiveOrderDelivery(guestOrder, { restaurantId, sessionId, sessionIds })) {
    // Same answer as "no such order": a refusal must not confirm that an order exists at an id
    // the caller cannot otherwise see.
    return NextResponse.json({ error: MENU_COPY.guestOrderNotFound }, { status: 404 })
  }

  if (String(order.payment_status || '').toLowerCase() !== 'paid') {
    return NextResponse.json({ error: MENU_COPY.receiptNotReadyUntilPaid }, { status: 400 })
  }

  let receipt
  try {
    receipt = await issueReceiptForOrder(orderId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to issue receipt'
      console.error('[guest/receipt/email] issueReceiptForOrder failed', { orderId, reason: message })
    return NextResponse.json({ error: MENU_COPY.somethingWentWrongAskStaff }, { status: 500 })
  }

  /**
   * #304 — `bindRecipientToFirstDelivery` IS SET HERE AND NOWHERE ELSE.
   *
   * This is the route with no session token. The two staff routes
   * (`app/api/orders/[orderId]/receipt/email`, `app/api/terminal/receipts/[orderId]/email`) do not
   * pass it and are unchanged: staff mailing one receipt to two addresses is the job.
   *
   * Reverting this fix is deleting this one argument.
   */
  const result = await sendReceiptEmail(receipt, email, { bindRecipientToFirstDelivery: true })

  if (result.status === 'failed') {
    /**
     * #244, RULED 2026-08-25. THE CUSTOMER IS TOLD ONE SENTENCE AND NOTHING ELSE.
     *
     * This route takes NO session token -- verified, zero auth calls -- so whatever goes in `error`
     * is readable by anyone with an order id. It used to be `result.errorMessage`, which is raw
     * provider text ("Resend rejected the receipt email") or, after the ceiling landed, our own
     * attempt count. Neither is the customer's business.
     *
     * THE STATUS CODE CARRIES THE DISTINCTION, not the body:
     *   attempt_ceiling  -> 429. We refused. Nothing upstream failed, so 502 was simply wrong.
     *   anything else    -> 502. The provider was asked and did not send.
     *
     * Read from `result.failure`, a code, rather than by matching the message -- a route that
     * branches on English breaks the next time the wording is edited.
     *
     * The real reason still reaches the log and the delivery row, which is where it is useful.
     */
    /**
     * #304 joins `recipient_not_bound` to the SAME 429 the ceiling already uses, rather than
     * inventing a third status. The 2026-08-25 ruling is that a deliberate refusal answers 429 and
     * a provider failure answers 502; a bound recipient is a deliberate refusal, so it belongs on
     * the side that already exists. Whether a refusal of this shape deserves its own status is a
     * wording-and-contract decision and is flagged on #304, not answered here.
     */
    const refused =
      result.failure === 'attempt_ceiling' || result.failure === 'recipient_not_bound'
    console.error('[guest/receipt/email] send failed', {
      orderId,
      deliveryId: result.deliveryId,
      failure: result.failure ?? 'unknown',
      reason: result.errorMessage,
    })
    return NextResponse.json(
      { error: MENU_COPY.receiptCouldNotBeSent, deliveryId: result.deliveryId },
      { status: refused ? 429 : 502 },
    )
  }

  return NextResponse.json({ success: true, deliveryId: result.deliveryId })
}
