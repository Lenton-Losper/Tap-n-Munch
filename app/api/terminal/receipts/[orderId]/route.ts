import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { renderReceiptEscPos } from '@/lib/receipts/renderers/escposRenderer'
import { renderReceiptSdk6 } from '@/lib/receipts/renderers/sdk6Renderer'
import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function parseCharacterWidth(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 32
  return Math.min(64, Math.max(16, Math.round(parsed)))
}

export async function GET(
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

    const url = new URL(req.url)
    // characterWidth is a printer layout param (not frozen at issue). Same snapshot + same
    // width ⇒ byte-identical ESC/POS; changing width intentionally changes layout.
    const characterWidth = parseCharacterWidth(url.searchParams.get('characterWidth'))

    const { data: receipt, error: receiptError } = await supabase
      .from('receipt_documents')
      .select('id, document_number, status, snapshot_json, issued_at')
      .eq('order_id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .eq('document_type', 'SALE_RECEIPT')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (receiptError) {
      return NextResponse.json({ error: 'Failed to load receipt' }, { status: 500 })
    }
    if (!receipt) {
      const { data: order } = await supabase
        .from('orders')
        .select('id, payment_status, paid_at, paycloud_merchant_order_no, payment_voucher_no')
        .eq('id', orderId)
        .eq('restaurant_id', terminal.restaurantId)
        .maybeSingle()

      const { data: issuanceFail } = await supabase
        .from('audit_logs')
        .select('created_at, metadata')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('entity_id', orderId)
        .eq('action', 'receipt.issuance_failed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      return NextResponse.json(
        {
          error: 'Receipt not found for this order',
          code: 'RECEIPT_NOT_READY',
          diagnostics: {
            orderFound: Boolean(order),
            paymentStatus: order?.payment_status ?? null,
            paidAt: order?.paid_at ?? null,
            hasMerchantOrderNo: Boolean(order?.paycloud_merchant_order_no),
            hasVoucherNo: Boolean(order?.payment_voucher_no),
            lastIssuanceFailureAt: issuanceFail?.created_at ?? null,
            lastIssuanceFailure: issuanceFail?.metadata ?? null,
          },
        },
        { status: 404 },
      )
    }

    const snapshot = receipt.snapshot_json as ReceiptSnapshot
    const documentNumber = String(receipt.document_number || '')
    const issuedAt = receipt.issued_at ? String(receipt.issued_at) : undefined
    const escposBytes = renderReceiptEscPos(snapshot, {
      characterWidth,
      documentNumber: documentNumber || undefined,
      issuedAt,
    })
    const sdk6Lines = renderReceiptSdk6(snapshot, {
      documentNumber: documentNumber || undefined,
      issuedAt,
    })

    return NextResponse.json({
      id: receipt.id,
      documentNumber: receipt.document_number,
      status: receipt.status,
      rendererVersion: snapshot.renderer_version ?? null,
      escposBase64: Buffer.from(escposBytes).toString('base64'),
      sdk6Lines,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/receipts]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
