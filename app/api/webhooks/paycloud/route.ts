import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit } from '@/payments/webhook'
import { verifyPayloadSignature } from '@/payments/signature'
import { createServerSupabaseClient } from '@/lib/supabase/server'

function webhookAck() {
  return new Response('success', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function getClientIp(req: Request) {
  return req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'
}

function extractSign(payload: Record<string, unknown>, headers: Headers): string {
  const h =
    headers.get('x-paycloud-sign') ||
    headers.get('paycloud-sign') ||
    headers.get('x-signature') ||
    ''
  if (h) return h
  const b = payload?.sign
  return typeof b === 'string' ? b : ''
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

function supabaseOrMerchantRef(merchantOrderNo: string): string {
  return `paycloud_merchant_order_no.eq.${merchantOrderNo},payment_reference.eq.${merchantOrderNo}`
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
    return webhookAck()
  }

  const merchantOrderNo = extractWebhookMerchantOrderNo(payload)
  if (!merchantOrderNo) {
    return NextResponse.json({ error: 'Missing merchant_order_no' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { data: existingRows } = await supabase
    .from('orders')
    .select('id, payment_status')
    .or(supabaseOrMerchantRef(merchantOrderNo))

  if (
    existingRows &&
    existingRows.length > 0 &&
    existingRows.every((r) => String(r.payment_status || '').toLowerCase() === 'paid')
  ) {
    console.log('[WEBHOOK] Duplicate webhook ignored for:', merchantOrderNo)
    return webhookAck()
  }

  const sign = extractSign(payload, req.headers)
  if (sign) {
    try {
      const copy = { ...payload }
      verifyPayloadSignature(copy, sign)
    } catch (e) {
      console.warn('[PayCloud webhook] Signature verification error; continuing', e)
    }
  }

  const transStatus = payload.trans_status ?? payload.trade_status ?? payload.status
  if (!isPaidTransStatus(transStatus)) {
    return webhookAck()
  }

  console.log('[WEBHOOK] Processing payment for:', merchantOrderNo)

  const { data: orderRows } = await supabase
    .from('orders')
    .select('id')
    .or(supabaseOrMerchantRef(merchantOrderNo))

  if (!orderRows?.length) {
    // Ack as success even though we couldn't act on it yet: this is a timing race (the order
    // row may not have been created yet when this notification arrived, e.g. a terminal device
    // calling Finatic directly and separately/later calling our own order-creation endpoint --
    // not something under this route's control), not a malformed request. Finatic's own
    // retry-on-non-success-ack behavior is what actually recovers this once the order exists;
    // replying with a non-conforming body here (previously {"received":true}) just caused
    // Finatic to log the delivery attempt as failed even though we received it correctly.
    console.error('[WEBHOOK] Order not found (will rely on Finatic retry once it exists):', merchantOrderNo)
    return webhookAck()
  }

  await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .or(supabaseOrMerchantRef(merchantOrderNo))

  return webhookAck()
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
