import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

type DeliveryBody = {
  receipt_document_id?: unknown
  status?: unknown
  provider?: unknown
  device_id?: unknown
  provider_reference?: unknown
  error_code?: unknown
  error_message?: unknown
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as DeliveryBody

    const receiptDocumentId = String(body.receipt_document_id ?? '').trim()
    if (!isUuid(receiptDocumentId)) {
      return NextResponse.json({ error: 'receipt_document_id must be a valid UUID' }, { status: 400 })
    }

    const status = String(body.status ?? '').trim()
    if (status !== 'sent' && status !== 'failed') {
      return NextResponse.json({ error: "status must be 'sent' or 'failed'" }, { status: 400 })
    }

    const { data: receipt, error: receiptError } = await supabase
      .from('receipt_documents')
      .select('id')
      .eq('id', receiptDocumentId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (receiptError) {
      return NextResponse.json({ error: 'Failed to validate receipt_document_id' }, { status: 500 })
    }
    if (!receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
    }

    // attempt_number is server-derived (count of prior PRINT attempts + 1), never trusted from
    // the client -- a retry is always a new row. Scoped to method=PRINT so EMAIL attempts
    // (sendReceiptEmail) do not inflate the print counter.
    const { count: priorAttempts, error: countError } = await supabase
      .from('receipt_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('receipt_document_id', receiptDocumentId)
      .eq('method', 'PRINT')

    if (countError) {
      return NextResponse.json({ error: 'Failed to compute attempt number' }, { status: 500 })
    }

    const provider = body.provider != null ? String(body.provider).trim() || null : null
    const deviceId =
      body.device_id != null ? String(body.device_id).trim() || null : terminal.terminalId
    const providerReference =
      body.provider_reference != null ? String(body.provider_reference).trim() || null : null
    const errorCode = body.error_code != null ? String(body.error_code).trim() || null : null
    const errorMessage = body.error_message != null ? String(body.error_message).trim() || null : null

    const now = new Date().toISOString()

    const { data: created, error: insertError } = await supabase
      .from('receipt_deliveries')
      .insert({
        receipt_document_id: receiptDocumentId,
        method: 'PRINT',
        status,
        attempt_number: (priorAttempts ?? 0) + 1,
        provider,
        provider_reference: providerReference,
        device_id: deviceId,
        error_code: status === 'failed' ? errorCode : null,
        error_message: status === 'failed' ? errorMessage : null,
        requested_at: now,
        completed_at: now,
      })
      .select('id, attempt_number, status')
      .single()

    if (insertError || !created) {
      console.error('[terminal/receipt-deliveries] insert failed:', insertError)
      return NextResponse.json({ error: 'Failed to record delivery attempt' }, { status: 500 })
    }

    return NextResponse.json(created)
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/receipt-deliveries]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
