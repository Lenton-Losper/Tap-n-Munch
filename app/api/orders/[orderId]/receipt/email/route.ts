import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import type { ReceiptDocument } from '@/lib/receipts/issueReceipt'
import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'

export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  const supabase = createServerSupabaseClient()

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, restaurant_id')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError) {
    return NextResponse.json({ error: orderError.message }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(String(order.restaurant_id), PERMISSIONS.ORDERS_READ, req)
  if (isAuthError(auth)) return auth

  const { data: existing, error: existingError } = await supabase
    .from('receipt_documents')
    .select('id, restaurant_id, outlet_id, order_id, document_type, document_number, version, status, currency, snapshot_json, issued_at, created_at')
    .eq('order_id', orderId)
    .eq('restaurant_id', order.restaurant_id)
    .eq('document_type', 'SALE_RECEIPT')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    return NextResponse.json({ error: 'Failed to load receipt' }, { status: 500 })
  }

  let receipt: ReceiptDocument
  try {
    receipt = (existing as ReceiptDocument | null) ?? (await issueReceiptForOrder(orderId))
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
