import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit, verifyWebhook } from '@/payments/webhook'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderIdsByMerchantOrderNo } from '@/lib/payments/resolve-order-by-merchant-order'
import { confirmWebhookOrderViaFinaticFallback } from '@/lib/payments/webhook-sig-fallback'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

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

type WebhookPath =
  | 'valid_signature'
  | 'valid_hmac'
  | 'fallback_verified_paid'
  | 'fallback_verified_not_paid'
  | 'fallback_already_paid'
  | 'fallback_query_failed'

function logWebhookPath(path: WebhookPath, detail: Record<string, unknown> = {}) {
  console.log('[PayCloud webhook] path=', path, detail)
}

/**
 * Routes webhook-confirmed payments through the same markOrderPaidConfirmed() every
 * other "this order is now confirmed paid" caller uses (terminal callback, verify-payment,
 * auto-cancel cron), instead of a shallow payment_status-only update. That shallow update
 * used to leave status stuck at 'pending' forever: once payment_status left the
 * CLAIMABLE_PAYMENT_STATUSES set, no other caller could ever complete the order (see
 * mark-order-paid-confirmed.ts). A claimed:false result here just means another caller
 * (e.g. a live terminal callback) already completed it concurrently -- not an error.
 */
async function markOrdersPaidConfirmedByIds(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  orderIds: string[],
  params: {
    reference: string
    source: string
    extraAuditMetadata?: Record<string, unknown>
  },
): Promise<{ updateError: Error | null }> {
  if (!orderIds.length) return { updateError: null }

  const { data: rows, error: loadError } = await supabase
    .from('orders')
    .select('id, restaurant_id, total, payment_method')
    .in('id', orderIds)

  if (loadError) return { updateError: new Error(loadError.message) }

  for (const row of rows ?? []) {
    try {
      await markOrderPaidConfirmed(supabase, {
        orderId: String(row.id),
        restaurantId: String(row.restaurant_id),
        reference: params.reference,
        amount: Number(row.total) || 0,
        paymentMethod: (row.payment_method as string) || 'card',
        source: params.source,
        extraAuditMetadata: params.extraAuditMetadata,
      })
    } catch (err) {
      return { updateError: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  return { updateError: null }
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

  // Fail closed on signature: never trust the payload's paid claims when RSA/HMAC fails.
  // Instead of stopping at 401, fall back to an independent Finatic order.query.
  const verifyResult = verifyWebhook(rawBody, payload, headersToObject(req.headers))

  if (verifyResult.ok) {
    const path: WebhookPath = verifyResult.mode === 'hmac' ? 'valid_hmac' : 'valid_signature'
    logWebhookPath(path, { mode: verifyResult.mode })

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
          path,
        })
        return webhookAck()
      }
    }

    const transStatus = payload.trans_status ?? payload.trade_status ?? payload.status
    if (!isPaidTransStatus(transStatus)) {
      return webhookAck()
    }

    console.log('[WEBHOOK] Processing payment for:', merchantOrderNo, {
      source: resolved.source,
      path,
    })

    if (!resolved.orderIds.length) {
      console.error(
        '[WEBHOOK] Order not found via orders or payment_events (returning 503 for retry):',
        merchantOrderNo,
      )
      return NextResponse.json({ error: 'Order not found' }, { status: 503 })
    }

    const { updateError } = await markOrdersPaidConfirmedByIds(supabase, resolved.orderIds, {
      reference: merchantOrderNo,
      source: 'paycloud_webhook_valid_signature',
      extraAuditMetadata: { businessOrderNo: merchantOrderNo, path },
    })
    if (updateError) {
      console.error('[WEBHOOK] mark paid failed:', updateError)
      return NextResponse.json({ error: 'Failed to mark paid' }, { status: 503 })
    }

    if (resolved.source === 'payment_events') {
      const { error: backfillError } = await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: merchantOrderNo })
        .in('id', resolved.orderIds)
        .is('paycloud_merchant_order_no', null)
      if (backfillError) {
        console.error('[WEBHOOK] merchant order no backfill failed:', backfillError)
      }
    }

    return webhookAck()
  }

  // Signature invalid/missing/error — do not trust payload claims. Independently query Finatic.
  const sigFailReason = verifyResult.reason || 'Invalid signature'
  const merchantOrderNo = extractWebhookMerchantOrderNo(payload)
  if (!merchantOrderNo) {
    logWebhookPath('fallback_query_failed', {
      reason: 'missing_merchant_order_no',
      sigFailReason,
    })
    return NextResponse.json({ error: sigFailReason }, { status: 401 })
  }

  const stagingStub = payload.__stagingFinaticStub
  const supabase = createServerSupabaseClient()

  let resolved: { orderIds: string[]; source: 'orders' | 'payment_events' | null }
  try {
    resolved = await resolveOrderIdsByMerchantOrderNo(supabase, merchantOrderNo)
  } catch (e) {
    console.error('[WEBHOOK] fallback order resolve failed:', e)
    logWebhookPath('fallback_query_failed', {
      merchantOrderNo,
      sigFailReason,
      reason: 'order_resolve_threw',
    })
    return NextResponse.json(
      { error: 'Finatic fallback query unavailable; retry later', reason: sigFailReason },
      { status: 503 },
    )
  }

  const fallback = await confirmWebhookOrderViaFinaticFallback({
    supabase,
    merchantOrderNo,
    orderIds: resolved.orderIds,
    stagingFinaticStub: stagingStub,
  })

  if (fallback.path === 'fallback_already_paid') {
    logWebhookPath('fallback_already_paid', {
      merchantOrderNo,
      orderIds: fallback.orderIds,
      sigFailReason,
    })
    return webhookAck()
  }

  if (fallback.path === 'fallback_verified_paid') {
    logWebhookPath('fallback_verified_paid', {
      merchantOrderNo,
      orderIds: fallback.orderIds,
      finaticStatus: fallback.finatic.status,
      finaticTransactionId: fallback.finatic.transactionId,
      finaticAmount: fallback.finatic.amount,
      sigFailReason,
    })

    const orderIds = fallback.orderIds.length ? fallback.orderIds : resolved.orderIds
    if (!orderIds.length) {
      return NextResponse.json({ error: 'Order not found' }, { status: 503 })
    }

    const { updateError } = await markOrdersPaidConfirmedByIds(supabase, orderIds, {
      reference: merchantOrderNo,
      source: 'paycloud_webhook_fallback_finatic_verified',
      extraAuditMetadata: {
        businessOrderNo: merchantOrderNo,
        path: 'fallback_verified_paid',
        signatureFailureReason: sigFailReason,
        finaticStatus: fallback.finatic.status,
        finaticTransactionId: fallback.finatic.transactionId,
        finaticAmount: fallback.finatic.amount,
        orderIds,
      },
    })
    if (updateError) {
      console.error('[WEBHOOK] fallback mark paid failed:', updateError)
      return NextResponse.json({ error: 'Failed to mark paid' }, { status: 503 })
    }

    if (resolved.source === 'payment_events') {
      const { error: backfillError } = await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: merchantOrderNo })
        .in('id', orderIds)
        .is('paycloud_merchant_order_no', null)
      if (backfillError) {
        console.error('[WEBHOOK] fallback merchant order no backfill failed:', backfillError)
      }
    }

    return webhookAck()
  }

  if (fallback.path === 'fallback_verified_not_paid') {
    logWebhookPath('fallback_verified_not_paid', {
      merchantOrderNo,
      orderIds: fallback.orderIds,
      finaticStatus: fallback.finatic.status,
      sigFailReason,
    })
    // Confirmed not paid via Finatic — ACK so Finatic stops retrying. Do not mark paid.
    return webhookAck()
  }

  // Uncertain / unreachable / missing credentials / no local order — do not guess; ask Finatic to retry.
  logWebhookPath('fallback_query_failed', {
    merchantOrderNo,
    orderIds: fallback.orderIds,
    reason: fallback.reason,
    sigFailReason,
  })
  return NextResponse.json(
    {
      error: 'Finatic fallback query unavailable; retry later',
      reason: fallback.reason,
      signatureFailureReason: sigFailReason,
    },
    { status: 503 },
  )
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
