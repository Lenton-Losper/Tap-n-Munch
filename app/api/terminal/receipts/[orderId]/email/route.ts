import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'
import type { ReceiptDocument } from '@/lib/receipts/issueReceipt'
import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'

export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Terminal-authenticated mirror of POST /api/orders/[orderId]/receipt/email -- same
 * sendReceiptEmail adapter, same append-only receipt_deliveries logging, just JWT
 * (requireTerminalAuth) instead of staff session auth, so the terminal itself can trigger
 * an email receipt. One email-sending code path, two auth boundaries.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({}))
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, restaurant_id')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (orderError) {
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const { data: existing, error: existingError } = await supabase
      .from('receipt_documents')
      .select('id, restaurant_id, outlet_id, order_id, document_type, document_number, version, status, currency, snapshot_json, issued_at, created_at')
      .eq('order_id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
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
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/receipts/email]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
