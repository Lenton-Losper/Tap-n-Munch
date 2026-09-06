import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit, verifyWebhook } from '@/payments/webhook'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  resolveOrderIdsByMerchantOrderNo,
  type ResolvedReference,
} from '@/lib/payments/resolve-order-by-merchant-order'
import { confirmWebhookOrderViaFinaticFallback } from '@/lib/payments/webhook-sig-fallback'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  claimableStatusesForRecovery,
  isCancelledOnE04111Evidence,
  recordRecoveredAfterAutoCancel,
} from '@/lib/payments/e04111-recovery'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'
import { recordPaymentAmountMismatch } from '@/lib/payments/record-amount-mismatch'

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

/**
 * #223. The payload's own claimed amount, for the signature-valid path. Same field
 * precedence payments/webhook.js's extractWebhookOrderRef already uses for this gateway
 * (`amount`, falling back to `paid_amount`), so a field this webhook already trusts for
 * everything else is not read under a different name here.
 *
 * Returns null for absent/unparseable -- ABSENT is not AGREEING, same convention as
 * queryFinaticOrderPaid's toMoney.
 */
function extractWebhookGatewayAmount(payload: Record<string, unknown>): number | null {
  const raw = payload.amount ?? payload.paid_amount
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
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

type MarkPaidOutcome = {
  updateError: Error | null
  claimedIds: string[]
  /** Orders the claim UPDATE could not apply, with why. */
  unclaimed: Array<{ orderId: string; reason: 'already_paid' | 'claim_conflict' }>
  /**
   * #223. True when the gateway's amount did not agree with the covered orders' total, or was
   * absent. Nothing was marked paid and nothing was cancelled; both figures were recorded on
   * every affected order for a human to resolve.
   */
  amountMismatch: boolean
}

/**
 * Routes webhook-confirmed payments through the same markOrderPaidConfirmed() every
 * other "this order is now confirmed paid" caller uses (terminal callback, verify-payment,
 * auto-cancel cron), instead of a shallow payment_status-only update. That shallow update
 * used to leave status stuck at 'pending' forever: once payment_status left the
 * CLAIMABLE_PAYMENT_STATUSES set, no other caller could ever complete the order (see
 * mark-order-paid-confirmed.ts).
 *
 * The claim result is now PROPAGATED rather than discarded. 'already_paid' is benign --
 * another caller (e.g. a live terminal callback) won the race. 'claim_conflict' is not:
 * it means Finatic confirmed a real payment that we then failed to apply, and the caller
 * must not ACK 200, or Finatic stops retrying and the payment is lost silently.
 *
 * Cancelled orders: an order auto-cancelled by the E04111 rule sits outside
 * CLAIMABLE_PAYMENT_STATUSES, so the claim would match zero rows and discard the payment.
 * claimableStatusesForRecovery widens the transition for exactly those orders.
 *
 * #223. GATEWAY leg: `gatewayAmount` must agree with the SUM of the covered orders' totals
 * before anything is written, at GATEWAY_AMOUNT_TOLERANCE_CENTS (zero) with ABSENT treated as
 * unverified, not agreeing -- same rule as the other three gateway legs named on
 * GATEWAY_AMOUNT_TOLERANCE_CENTS's own docblock. Compared ONCE against the sum, not per order:
 * a webhook event can name several orders at once (a tab settle), and the gateway's single
 * figure is for all of them together. REFUSED here, not quarantined -- quarantine is #223's
 * cron leg only, because refusing there would let the same sweep cancel a card that had
 * already been charged. This route has no such follow-up sweep, so refusing (leaving the
 * orders exactly as they were, both figures recorded) is the safe default.
 */
async function markOrdersPaidConfirmedByIds(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  orderIds: string[],
  params: {
    reference: string
    source: string
    extraAuditMetadata?: Record<string, unknown>
    /** #223. The gateway-confirmed amount for this event, covering ALL orderIds combined. null means the gateway gave no amount at all. */
    gatewayAmount: number | null
  },
): Promise<MarkPaidOutcome> {
  const outcome: MarkPaidOutcome = {
    updateError: null,
    claimedIds: [],
    unclaimed: [],
    amountMismatch: false,
  }
  if (!orderIds.length) return outcome

  const { data: rows, error: loadError } = await supabase
    .from('orders')
    .select('id, restaurant_id, total, payment_method, payment_status, cancellation_reason, cancelled_at')
    .in('id', orderIds)

  if (loadError) {
    outcome.updateError = new Error(loadError.message)
    return outcome
  }

  const orderRows = rows ?? []
  const expectedAmount = orderRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0)
  const verified =
    params.gatewayAmount !== null &&
    amountsMatch(params.gatewayAmount, expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS)

  if (!verified) {
    const reason =
      params.gatewayAmount === null
        ? `PayCloud webhook confirmed a payment for ${params.reference} but gave no amount -- ` +
          'the amount was never verified, so it is not applied.'
        : `PayCloud webhook confirmed ${params.gatewayAmount} for ${params.reference}, but the ` +
          `covered order(s) total ${expectedAmount} -- not applying, and not cancelling an ` +
          'order the gateway says was charged.'
    console.error(`[WEBHOOK] ${reason}`)

    for (const row of orderRows) {
      const orderId = String(row.id)
      const restaurantId = String(row.restaurant_id)

      if (params.gatewayAmount !== null) {
        await recordPaymentAmountMismatch(supabase, {
          restaurantId,
          orderId,
          expectedAmount,
          receivedAmount: params.gatewayAmount,
          source: 'paycloud_webhook',
          businessOrderNo: params.reference,
          reference: params.reference,
        })
      }

      const { error: uncertainAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: restaurantId,
        action: 'payment.verification_uncertain',
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          reason,
          gatewayAmount: params.gatewayAmount,
          expectedAmount,
          amountVerified: false,
          businessOrderNo: params.reference,
          source: params.source,
          outcome: 'left_pending_finatic_uncertain',
        },
      })
      if (uncertainAuditError) {
        console.error(
          '[WEBHOOK] payment.verification_uncertain audit failed:',
          uncertainAuditError,
        )
      }
    }

    outcome.amountMismatch = true
    return outcome
  }

  /**
   * #268. THE GATEWAY'S FIGURE, RECORDED ON THE SUCCESS PATH TOO.
   *
   * Until now `params.gatewayAmount` was used to GATE the write (the `verified` check above) and
   * was written to the audit trail only on the FAILURE path, at `payment.verification_uncertain`.
   * Every successful webhook therefore recorded `gatewayAmount: null` and
   * `amountMeaning: 'order_total'` — mark-order-paid-confirmed.ts:144-145 — so the provider's own
   * number, the one thing that made the payment auditable, survived only when it disagreed.
   *
   * IT CANNOT SIMPLY BE PASSED THROUGH, and that is the whole subtlety. This function's own
   * docblock says it: a webhook event can name SEVERAL orders at once (a tab settle) and the
   * gateway's single figure is for all of them together — which is why `verified` compares it once
   * against the SUM. Handing that settlement-level figure to a PER-ORDER audit row would record
   * "the gateway reported N$240 for this N$60 order" on four rows, and be wrong on all four. That
   * is the #226 shape: an event amount is per-settle, never per-order.
   *
   * So the two cases are recorded differently, and honestly:
   *
   *   ONE order covered  -> the settlement IS this order, so `gatewayAmount` is this order's
   *                         gateway figure and `amountMeaning` correctly becomes 'gateway_reported'.
   *                         Exact, not approximate: GATEWAY_AMOUNT_TOLERANCE_CENTS is zero and
   *                         `verified` is true to be here, so gatewayAmount === row.total.
   *
   *   MANY orders covered -> `gatewayAmount` stays null, because there is no per-order gateway
   *                         figure and inventing one is worse than having none. The settlement's
   *                         real numbers go into the audit metadata under names that say what they
   *                         are, so the event remains reconstructable without any row claiming the
   *                         figure is its own.
   */
  const singleOrderSettlement = orderRows.length === 1
  const settlementAudit: Record<string, unknown> =
    params.gatewayAmount === null
      ? {}
      : singleOrderSettlement
        ? {}
        : {
            settlementGatewayAmount: params.gatewayAmount,
            settlementExpectedAmount: expectedAmount,
            settlementOrderCount: orderRows.length,
          }

  for (const row of orderRows) {
    const orderId = String(row.id)
    const restaurantId = String(row.restaurant_id)
    const recoveringAutoCancelled = isCancelledOnE04111Evidence(row)

    try {
      const claim = await markOrderPaidConfirmed(supabase, {
        orderId,
        restaurantId,
        reference: params.reference,
        amount: Number(row.total) || 0,
        gatewayAmount: singleOrderSettlement ? params.gatewayAmount : null,
        paymentMethod: (row.payment_method as string) || 'card',
        source: params.source,
        extraAuditMetadata: recoveringAutoCancelled
          ? { ...params.extraAuditMetadata, ...settlementAudit, recoveredAfterAutoCancel: true }
          : { ...params.extraAuditMetadata, ...settlementAudit },
        fromPaymentStatuses: claimableStatusesForRecovery(row),
      })

      if (claim.claimed) {
        outcome.claimedIds.push(orderId)
        if (recoveringAutoCancelled) {
          await recordRecoveredAfterAutoCancel(supabase, {
            restaurantId,
            orderId,
            reference: params.reference,
            source: params.source,
            previousCancellationReason: row.cancellation_reason
              ? String(row.cancellation_reason)
              : null,
            previousCancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
            amount: Number(row.total) || 0,
            metadata: params.extraAuditMetadata,
          })
        }
      } else {
        outcome.unclaimed.push({ orderId, reason: claim.reason })
      }
    } catch (err) {
      outcome.updateError = err instanceof Error ? err : new Error(String(err))
      return outcome
    }
  }

  return outcome
}

/**
 * A verified payment we could not apply must never be ACKed -- Finatic would stop
 * retrying and the payment would be lost with a success log. 'already_paid' is the one
 * benign case: the order reached the same end state via another caller.
 */
function unappliedClaims(outcome: MarkPaidOutcome) {
  return outcome.unclaimed.filter((u) => u.reason !== 'already_paid')
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

    let resolved: ResolvedReference
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

    const markOutcome = await markOrdersPaidConfirmedByIds(supabase, resolved.orderIds, {
      reference: merchantOrderNo,
      source: 'paycloud_webhook_valid_signature',
      extraAuditMetadata: { businessOrderNo: merchantOrderNo, path },
      gatewayAmount: extractWebhookGatewayAmount(payload),
    })
    if (markOutcome.updateError) {
      console.error('[WEBHOOK] mark paid failed:', markOutcome.updateError)
      return NextResponse.json({ error: 'Failed to mark paid' }, { status: 503 })
    }
    if (markOutcome.amountMismatch) {
      // #223. Recorded on every affected order already. ACK rather than 503 -- Finatic will
      // keep sending the same disagreeing amount on retry, so there is nothing a retry can
      // resolve; a human resolves it from the audit trail.
      return webhookAck()
    }
    const blocked = unappliedClaims(markOutcome)
    if (blocked.length) {
      console.error(
        '[WEBHOOK] verified payment could not be applied (returning 503 for retry):',
        merchantOrderNo,
        blocked,
      )
      return NextResponse.json(
        { error: 'Payment confirmed but not applied; retry later', unclaimed: blocked },
        { status: 503 },
      )
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

  let resolved: ResolvedReference
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

    const markOutcome = await markOrdersPaidConfirmedByIds(supabase, orderIds, {
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
      gatewayAmount: fallback.finatic.amount,
    })
    if (markOutcome.updateError) {
      console.error('[WEBHOOK] fallback mark paid failed:', markOutcome.updateError)
      return NextResponse.json({ error: 'Failed to mark paid' }, { status: 503 })
    }
    if (markOutcome.amountMismatch) {
      // #223. Same reasoning as the signature-valid path: recorded already, and a retry
      // cannot change what Finatic reports for this reference.
      return webhookAck()
    }
    const blocked = unappliedClaims(markOutcome)
    if (blocked.length) {
      // Finatic independently confirmed this payment. Failing to apply it and ACKing
      // anyway is exactly how a real payment gets discarded with a success log.
      console.error(
        '[WEBHOOK] Finatic-verified payment could not be applied (returning 503 for retry):',
        merchantOrderNo,
        blocked,
      )
      return NextResponse.json(
        { error: 'Payment confirmed but not applied; retry later', unclaimed: blocked },
        { status: 503 },
      )
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
    gatewayCode: fallback.gatewayCode,
    // E04111 here means Finatic has no record of the reference *yet*. Retrying is the
    // whole point -- #149 registered 22 seconds later.
    isE04111: fallback.isE04111,
    sigFailReason,
  })
  return NextResponse.json(
    {
      error: 'Finatic fallback query unavailable; retry later',
      reason: fallback.reason,
      gatewayCode: fallback.gatewayCode,
      signatureFailureReason: sigFailReason,
    },
    { status: 503 },
  )
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification', req.url)
  return webhookAck()
}
