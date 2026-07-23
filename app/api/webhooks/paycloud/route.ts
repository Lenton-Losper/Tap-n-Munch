import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit } from '@/payments/webhook'
import { verifyPayloadSignature } from '@/payments/signature'
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

  let resolved: { orderIds: string[]; source: 'orders' | 'payment_events' | null }
  try {
    resolved = await resolveOrderIdsByMerchantOrderNo(supabase, merchantOrderNo)
  } catch (e) {
    console.error('[WEBHOOK] order resolve failed:', e)
    return webhookAck()
  }

  if (resolved.orderIds.length > 0) {
    const { data: existingRows } = await supabase
      .from('orders')
      .select('id, payment_status')
      .in('id', resolved.orderIds)

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

  console.log('[WEBHOOK] Processing payment for:', merchantOrderNo, { source: resolved.source })

  if (!resolved.orderIds.length) {
    console.error(
      '[WEBHOOK] Order not found via orders or payment_events (will rely on Finatic retry):',
      merchantOrderNo,
    )
    return webhookAck()
  }

  const paidAt = new Date().toISOString()

  await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      paid_at: paidAt,
    })
    .in('id', resolved.orderIds)

  // Backfill correlation key when we only found the order via payment_events (legacy POS).
  if (resolved.source === 'payment_events') {
    await supabase
      .from('orders')
      .update({ paycloud_merchant_order_no: merchantOrderNo })
      .in('id', resolved.orderIds)
      .is('paycloud_merchant_order_no', null)
  }

  await safeIssueReceiptsForOrders(resolved.orderIds, 'webhooks/paycloud')

  return webhookAck()
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
