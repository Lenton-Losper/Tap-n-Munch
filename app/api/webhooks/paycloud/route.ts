import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit, verifyWebhook } from '@/payments/webhook'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'
import { resolveOrderIdsByMerchantOrderNo } from '@/lib/payments/resolve-order-by-merchant-order'

function webhookAck() {
  return new Response('success', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function getClientIp(req: Request) {
  return req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function extractWebhookMerchantOrderNo(payload: Record<string, unknown>): string {
  const coerce = (v: unknown): string => {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  let s = coerce(payload.merchant_order_no ?? payload.out_trade_no ?? payload.order_id)
  if (s) return s
  let biz: unknown = payload.biz_data
  if (typeof biz === 'string') {
    try {
      biz = JSON.parse(biz) as Record<string, unknown>
    } catch {
      biz = null
    }
  }
  if (biz && typeof biz === 'object' && !Array.isArray(biz)) {
    const b = biz as Record<string, unknown>
    s = coerce(b.merchant_order_no ?? b.out_trade_no)
    if (s) return s
  }
  return ''
}

function isPaidTransStatus(transStatus: unknown): boolean {
  if (transStatus === 2 || transStatus === '2') return true
  const s = String(transStatus ?? '').toLowerCase()
  return s === 'paid' || s === 'success' || s === 'succeeded'
}

export async function POST(req: Request) {
  const rate = enforceWebhookRateLimit(getClientIp(req))
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
  }

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  // Fail closed: missing/invalid signature must never mark orders paid or ACK success.
  const verifyResult = verifyWebhook(rawBody, payload, headersToObject(req.headers))
  if (!verifyResult.ok) {
    console.warn('[PayCloud webhook] Signature rejected:', verifyResult.reason)
    return NextResponse.json({ error: verifyResult.reason || 'Invalid signature' }, { status: 401 })
  }

  const merchantOrderNo = extractWebhookMerchantOrderNo(payload)
  if (!merchantOrderNo) {
    return NextResponse.json({ error: 'Missing merchant_order_no' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  let resolved: { orderIds: string[]; source: 'orders' | 'payment_events' | null }
  try {
    resolved = await resolveOrderIdsByMerchantOrderNo(supabase, merchantOrderNo)
  } catch (e) {
    console.error('[WEBHOOK] order resolve failed:', e)
    // Do not ACK — provider should retry until durable resolve succeeds.
    return NextResponse.json({ error: 'Order resolve failed' }, { status: 503 })
  }

  if (resolved.orderIds.length > 0) {
    const { data: existingRows, error: existingError } = await supabase
      .from('orders')
      .select('id, payment_status')
      .in('id', resolved.orderIds)

    if (existingError) {
      console.error('[WEBHOOK] existing payment_status check failed:', existingError)
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 503 })
    }

    if (
      existingRows &&
      existingRows.length > 0 &&
      existingRows.every((r) => String(r.payment_status || '').toLowerCase() === 'paid')
    ) {
      console.log('[WEBHOOK] Duplicate webhook ignored for:', merchantOrderNo, {
        source: resolved.source,
      })
      return webhookAck()
    }
  }

  const transStatus = payload.trans_status ?? payload.trade_status ?? payload.status
  if (!isPaidTransStatus(transStatus)) {
    // Non-paid notify: ACK so the provider does not retry forever.
    return webhookAck()
  }

  console.log('[WEBHOOK] Processing payment for:', merchantOrderNo, { source: resolved.source })

  if (!resolved.orderIds.length) {
    console.error(
      '[WEBHOOK] Order not found via orders or payment_events (returning 503 for retry):',
      merchantOrderNo,
    )
    return NextResponse.json({ error: 'Order not found' }, { status: 503 })
  }

  const paidAt = new Date().toISOString()

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      paid_at: paidAt,
    })
    .in('id', resolved.orderIds)

  if (updateError) {
    console.error('[WEBHOOK] mark paid failed:', updateError)
    return NextResponse.json({ error: 'Failed to mark paid' }, { status: 503 })
  }

  // Backfill correlation key when we only found the order via payment_events (legacy POS).
  if (resolved.source === 'payment_events') {
    const { error: backfillError } = await supabase
      .from('orders')
      .update({ paycloud_merchant_order_no: merchantOrderNo })
      .in('id', resolved.orderIds)
      .is('paycloud_merchant_order_no', null)
    if (backfillError) {
      console.error('[WEBHOOK] merchant order no backfill failed:', backfillError)
      // Paid write already succeeded — still ACK; backfill is best-effort.
    }
  }

  await safeIssueReceiptsForOrders(resolved.orderIds, 'webhooks/paycloud')

  return webhookAck()
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
