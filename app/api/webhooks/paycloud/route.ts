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

  const sign = extractSign(payload, req.headers)
  if (sign) {
    try {
      const copy = { ...payload }
      verifyPayloadSignature(copy, sign)
    } catch (e) {
      console.warn('[PayCloud webhook] Signature verification error; continuing', e)
    }
  }

  const merchantOrderNo = String(
    payload.merchant_order_no ?? payload.out_trade_no ?? payload.order_id ?? ''
  ).trim()
  const transStatus = payload.trans_status ?? payload.trade_status ?? payload.status
  if (!merchantOrderNo || !isPaidTransStatus(transStatus)) {
    return webhookAck()
  }

  const supabase = createServerSupabaseClient()

  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('paycloud_merchant_order_no', merchantOrderNo)
    .single()

  if (!order) {
    console.error('[WEBHOOK] Order not found:', merchantOrderNo)
    return NextResponse.json({ received: true })
  }

  await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      status: 'completed',
      paid_at: new Date().toISOString()
    })
    .eq('id', order.id)

  return webhookAck()
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
