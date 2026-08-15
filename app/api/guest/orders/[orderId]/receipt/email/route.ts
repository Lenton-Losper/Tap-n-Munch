import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { guestCanReceiveOrderDelivery } from '@/lib/guest-orders/validation'
import { parseOptionalInt } from '@/lib/guest-orders/validation'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'
import type { GuestOrderRow } from '@/lib/guest-orders/types'

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
 * Now gated on `guestCanReceiveOrderDelivery`: restaurant, PLUS the table the order sits at or a
 * session id it was placed under. See that function for why the read helper was left alone
 * (#279 is a recorded decision with a test pinning it) rather than tightened in place.
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
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const restaurantId =
    searchParams.get('restaurantId')?.trim() ||
    searchParams.get('restaurant_id')?.trim() ||
    (typeof body?.restaurantId === 'string' ? body.restaurantId.trim() : '') ||
    (typeof body?.restaurant_id === 'string' ? body.restaurant_id.trim() : '')
  const tableNumber = parseOptionalInt(searchParams.get('table_number')) ?? parseOptionalInt(body?.table_number)
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
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const guestOrder = { ...order, id: String(order.id) } as GuestOrderRow
  if (!guestCanReceiveOrderDelivery(guestOrder, { restaurantId, tableNumber, sessionId, sessionIds })) {
    // Same answer as "no such order": a refusal must not confirm that an order exists at an id
    // the caller cannot otherwise see.
    return NextResponse.json({ error: 'Order not accessible' }, { status: 404 })
  }

  if (String(order.payment_status || '').toLowerCase() !== 'paid') {
    return NextResponse.json({ error: 'Receipt is not available until the order is paid' }, { status: 400 })
  }

  let receipt
  try {
    receipt = await issueReceiptForOrder(orderId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to issue receipt'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const result = await sendReceiptEmail(receipt, email)

  if (result.status === 'failed') {
    return NextResponse.json(
      { error: result.errorMessage || 'Failed to send receipt email', deliveryId: result.deliveryId },
      { status: 502 },
    )
  }

  return NextResponse.json({ success: true, deliveryId: result.deliveryId })
}
