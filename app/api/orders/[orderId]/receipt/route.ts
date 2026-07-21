import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import type { ReceiptDocument, ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'

export const dynamic = 'force-dynamic'

/**
 * Staff-facing (dashboard) receipt lookup -- distinct from app/api/terminal/receipts/[orderId],
 * which is JWT-authenticated for the Bluetooth print flow. This route returns rendered HTML
 * for the "print from this computer" and "email receipt" dashboard actions. Unlike the
 * terminal route, it issues the receipt on demand if it doesn't already exist (issuance is
 * automatic at payment completion, but this is a defensive fallback, not the primary path).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
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

  const html = renderReceiptHtml(receipt.snapshot_json as ReceiptSnapshot, {
    documentNumber: receipt.document_number,
    issuedAt: receipt.issued_at,
  })

  return NextResponse.json({
    id: receipt.id,
    documentNumber: receipt.document_number,
    html,
  })
}
