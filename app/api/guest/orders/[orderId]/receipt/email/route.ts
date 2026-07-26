import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { guestCanAccessOrder } from '@/lib/guest-orders/validation'
import { parseOptionalInt } from '@/lib/guest-orders/validation'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'
import type { GuestOrderRow } from '@/lib/guest-orders/types'

export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Guest-facing "email my receipt" -- no staff auth, same table/session access check
 * fetchGuestOrderById uses elsewhere. Distinct from the staff route
 * (app/api/orders/[orderId]/receipt/email), which is behind requireStaffPermission.
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
  const tableNumber = parseOptionalInt(searchParams.get('table_number')) ?? parseOptionalInt(body?.table_number)
  const sessionId = searchParams.get('session_id') || (typeof body?.session_id === 'string' ? body.session_id : null)

  const supabase = createServerSupabaseClient()

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, restaurant_id, table_number, session_id, is_closed, status, payment_status')
    .eq('id', orderId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const guestOrder = { ...order, id: String(order.id) } as GuestOrderRow
  if (!guestCanAccessOrder(guestOrder, { tableNumber, sessionId })) {
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
