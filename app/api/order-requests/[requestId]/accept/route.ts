import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'
import { createOrder } from '@/lib/orders/create-order'
import { createPaymentRequest, paycloudWireMerchantOrderNo } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'

export const dynamic = 'force-dynamic'

/**
 * Accept a table/kiosk order request: the only place a real `orders` row gets created for
 * these channels now. Uses the staff-reviewed items/totals if a review was saved, otherwise
 * the customer's original submission. route_to enrichment and (for hosted checkout) the
 * Finatic session are deliberately deferred to here, not request submission -- payment must
 * never trigger before Accept.
 *
 * Concurrency: the request row is claimed into a transient 'accepting' status with
 * UPDATE ... WHERE status = 'waiting_review' BEFORE createOrder() is ever called -- zero
 * rows means another Accept/Decline already won, and we return 409 without creating
 * anything. 'accepting' (not 'accepted' directly) exists because the
 * order_requests_accepted_has_order CHECK requires accepted_order_id IS NOT NULL whenever
 * status = 'accepted', and that column FKs to orders(id) -- neither is satisfiable until
 * createOrder() has actually run. Only the claim winner ever calls createOrder(); if it
 * throws, the claim is released back to 'waiting_review' so the request isn't stranded.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params
  const supabase = createServerSupabaseClient()

  const { data: request, error: loadError } = await supabase
    .from('order_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }
  if (!request) {
    return NextResponse.json({ error: 'Order request not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(String(request.restaurant_id), PERMISSIONS.ORDERS_UPDATE, req)
  if (isAuthError(auth)) return auth

  if (request.status === 'accepted') {
    // Idempotent: a retried Accept after success returns the same result, not a new order.
    return NextResponse.json({ success: true, orderId: request.accepted_order_id })
  }
  if (request.status !== 'waiting_review') {
    return NextResponse.json(
      { error: `Cannot accept a request with status "${request.status}"` },
      { status: 409 },
    )
  }

  // Atomic claim FIRST -- before createOrder() is ever called. Zero rows means another
  // Accept/Decline already won this request; return 409 without creating anything.
  const { data: claimed, error: claimError } = await supabase
    .from('order_requests')
    .update({ status: 'accepting' })
    .eq('id', requestId)
    .eq('status', 'waiting_review')
    .select('*')
    .maybeSingle()

  if (claimError) {
    console.error('[ORDER_REQUESTS/accept] failed to claim request:', claimError)
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }
  if (!claimed) {
    // Another Accept (or Decline) already transitioned this row.
    return NextResponse.json(
      { error: 'Order request already handled' },
      { status: 409 },
    )
  }

  const items = Array.isArray(claimed.items_reviewed) ? claimed.items_reviewed : claimed.items
  const subtotal = claimed.subtotal_reviewed ?? claimed.subtotal
  const total = claimed.total_reviewed ?? claimed.total

  const enrichedItems = await enrichOrderItemsWithRouteTo(supabase, items)

  // Stable across retries so createOrder's 23505 path collapses to one orders row even
  // when the client-submitted idempotency_key is null.
  const acceptIdempotencyKey =
    String(claimed.idempotency_key || '').trim() || `order-request-accept:${requestId}`

  let result
  try {
    result = await createOrder({
      restaurantId: claimed.restaurant_id,
      firebaseRestaurantId: claimed.firebase_restaurant_id,
      tableNumber: claimed.table_number,
      tableId: claimed.table_id,
      sessionId: claimed.session_id,
      memberSessionId: claimed.member_session_id,
      items: enrichedItems,
      subtotal: Number(subtotal) || 0,
      total: Number(total) || 0,
      paymentMethod: claimed.payment_method,
      paymentChannel: claimed.payment_channel,
      paymentStatus: 'pending',
      orderInstructions: claimed.order_instructions,
      tabId: claimed.tab_id,
      tabSettlementForTabId: claimed.tab_settlement_for_tab_id,
      channel: claimed.channel,
      customerName: claimed.customer_name,
      idempotencyKey: acceptIdempotencyKey,
    })
  } catch (err) {
    // Release the claim so the request can be retried (Accept again, or Decline) instead
    // of being stranded in 'accepting' forever.
    await supabase
      .from('order_requests')
      .update({ status: 'waiting_review' })
      .eq('id', requestId)
      .eq('status', 'accepting')
    const message = err instanceof Error ? err.message : 'Failed to create order'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const orderId = result.orderId

  const { error: finalizeError } = await supabase
    .from('order_requests')
    .update({
      status: 'accepted',
      accepted_order_id: orderId,
      decided_at: new Date().toISOString(),
      decided_by: auth.userId,
    })
    .eq('id', requestId)
    .eq('status', 'accepting')

  if (finalizeError) {
    // The order now exists but the request row couldn't be finalized -- surface this
    // loudly rather than silently leaving the request stuck in 'accepting'. The order
    // itself is real and correct; staff can resolve the request row manually.
    console.error('[ORDER_REQUESTS/accept] failed to finalize accepted request:', finalizeError)
    return NextResponse.json(
      { error: `Order created (${orderId}) but request could not be finalized: ${finalizeError.message}` },
      { status: 500 },
    )
  }

  // Kiosk order numbering (daily counter), same as the old direct-creation path.
  let kioskOrderNumber: number | undefined
  if (request.channel === 'kiosk') {
    const today = new Date().toISOString().split('T')[0]
    const { count: kioskCount } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', request.restaurant_id)
      .eq('channel', 'kiosk')
      .gte('placed_at', `${today}T00:00:00Z`)

    kioskOrderNumber = (kioskCount ?? 0) + 1
    await supabase.from('orders').update({ kiosk_order_number: kioskOrderNumber }).eq('id', orderId)
  }

  // Tab bookkeeping (members + running total), same as the old direct-creation path.
  if (request.tab_id) {
    const { data: tabRow } = await supabase
      .from('tabs')
      .select('total, members')
      .eq('id', request.tab_id)
      .single()

    if (tabRow) {
      const members = Array.isArray(tabRow.members) ? [...tabRow.members] : []
      const sid = request.member_session_id || request.session_id
      if (sid && !members.some((m: { session_id?: string }) => String(m?.session_id) === sid)) {
        members.push({
          session_id: sid,
          joined_at: new Date().toISOString(),
          display_name: `Person ${members.length + 1}`,
        })
      }
      const { data: tabOrdersForTotal } = await supabase
        .from('orders')
        .select('total, tab_settlement_for_tab_id')
        .eq('tab_id', request.tab_id)

      const nextTotal = (tabOrdersForTotal || [])
        .filter((o) => !String(o.tab_settlement_for_tab_id || '').trim())
        .reduce((sum, o) => sum + (Number(o.total) || 0), 0)

      await supabase.from('tabs').update({ total: nextTotal, members }).eq('id', request.tab_id)
    }
  }

  // Hosted/online checkout: the Finatic session now fires here (post-Accept), never at
  // request submission. Best-effort -- an order still exists even if this fails, same
  // tolerance the old inline try/catch in POST /api/orders had.
  // Only the claim winner reaches this block (prevents duplicate Finatic sessions).
  let checkoutUrl: string | null = null
  let merchantOrderNo: string | null = null
  if (!request.tab_id && String(request.payment_channel || '') === 'hosted') {
    try {
      const credentials = await getRestaurantFinaticCredentials(request.restaurant_id)
      const paymentResult = await createPaymentRequest({
        amount: Number(total) || 0,
        currency: 'NAD',
        description: `FlashTap Table ${request.table_number} Order #${result.orderNumber}`,
        restaurantId: request.restaurant_id,
        orderId,
        merchantNo: credentials.checkoutMerchantNo,
        storeNo: credentials.checkoutStoreNo,
        checkoutReturnParams: {
          rid: String(request.restaurant_id),
          table: String(request.table_number),
        },
      })

      const paymentResultAny = paymentResult as { checkoutUrl?: string; pay_url?: string } | undefined
      checkoutUrl = paymentResultAny?.checkoutUrl || paymentResultAny?.pay_url || null
      merchantOrderNo = paycloudWireMerchantOrderNo(orderId)

      await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: merchantOrderNo, payment_checkout_url: checkoutUrl })
        .eq('id', orderId)
    } catch (payErr) {
      console.error('[ORDER_REQUESTS/accept] hosted checkout init failed:', payErr)
    }
  }

  return NextResponse.json({
    success: true,
    orderId,
    orderNumber: result.orderNumber,
    checkoutUrl,
    merchantOrderNo,
    ...(kioskOrderNumber != null ? { kioskOrderNumber, kioskOrderLabel: `K-${String(kioskOrderNumber).padStart(3, '0')}` } : {}),
  })
}
