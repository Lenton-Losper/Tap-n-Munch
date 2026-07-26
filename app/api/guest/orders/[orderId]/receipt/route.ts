import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { guestCanAccessOrder } from '@/lib/guest-orders/validation'
import { parseOptionalInt } from '@/lib/guest-orders/validation'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { renderReceiptPdf } from '@/lib/receipts/renderers/pdfRenderer'
import type { GuestOrderRow } from '@/lib/guest-orders/types'

export const dynamic = 'force-dynamic'

/**
 * Guest-facing receipt download -- no staff auth, same table/session access check
 * fetchGuestOrderById uses elsewhere. Distinct from the staff route
 * (app/api/orders/[orderId]/receipt), which returns rendered HTML for the dashboard
 * print/email actions; this one returns real PDF bytes for a customer download.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const supabase = createServerSupabaseClient()

  const { searchParams } = new URL(req.url)
  const tableNumber = parseOptionalInt(searchParams.get('table_number'))
  const sessionId = searchParams.get('session_id')

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

  const pdfBytes = await renderReceiptPdf(receipt.snapshot_json as ReceiptSnapshot, {
    documentNumber: receipt.document_number,
    issuedAt: receipt.issued_at,
  })

  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Receipt-${receipt.document_number}.pdf"`,
    },
  })
}
