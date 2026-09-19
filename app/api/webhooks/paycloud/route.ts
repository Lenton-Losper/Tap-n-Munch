import { NextResponse } from 'next/server'
import { enforceWebhookRateLimit, verifyWebhook } from '@/payments/webhook'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  resolveOrderIdsByMerchantOrderNo,
  type ResolvedReference,
} from '@/lib/payments/resolve-order-by-merchant-order'
import { markIntentConfirmed } from '@/lib/payments/payment-intents'
import { settleAllocationsForIntent } from '@/lib/payments/settle-allocations-for-intent'
import { confirmWebhookOrderViaFinaticFallback } from '@/lib/payments/webhook-sig-fallback'
/**
 * THE ONE WHOLE-ORDER WRITER.
 *
 * It replaces the local `markOrdersPaidConfirmedByIds`, which held the verified set and a
 * narrower applied set at the same time -- the Riviera defect. Everything that writer imported
 * piecemeal (the expectation, the settlement expansion, the amount comparison, the per-order
 * claim, the E04111 recovery) now lives behind this one function, so this route can no longer
 * assemble a second version of any of them.
 */
import { settleWholeOrderPayment } from '@/lib/payments/settle-whole-order-payment'

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

/**
 * THE GATEWAY'S OWN TRANSACTION ID, for the ledger row (F2).
 *
 * `payment_events.transaction_id` is what reconciliation joins a FlashTap payment to a Finatic
 * one by, and it carries the per-venue uniqueness that enforces "one gateway transaction = one
 * internal payment record". The signature-valid leg had no reason to read it before, because
 * nothing on this path wrote a ledger row at all.
 *
 * Field precedence matches what the fallback leg already gets back from
 * `queryFinaticOrderPaid`, so one concept is not read under two different names.
 */
function extractWebhookTransactionId(payload: Record<string, unknown>): string | null {
  const raw =
    payload.transaction_id ??
    payload.trans_no ??
    payload.trade_no ??
    payload.payment_trans_no
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  return s || null
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

type GatewaySettlementOutcome = {
  /** A transient failure. The caller must NOT ACK -- Finatic has to retry. */
  retryable: boolean
  /**
   * The settlement was refused for a reason a retry cannot change (the gateway will report the
   * same figure again). Recorded on every affected order already; a human resolves it.
   */
  permanentRefusal: boolean
  applied: boolean
  claimedIds: string[]
  detail?: unknown
}

/**
 * ==================================================================================================
 * APPLY A GATEWAY-CONFIRMED WHOLE-ORDER PAYMENT.
 * ==================================================================================================
 *
 * WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS NOT A ONE-LINE FIX.
 *
 * `markOrdersPaidConfirmedByIds` held two arrays and used the wrong one twice:
 *
 *   settlementRows   the expanded settlement  -- what the amount was VERIFIED against
 *   orderRows        the resolver's lead rows -- what the write loop and the
 *                    `singleOrderSettlement` audit flag actually used
 *
 * Riviera, 2026-09-18: a N$720 charge over orders #154 and #155 verified against both and applied
 * to #155 alone, leaving #154 unpaid and recording `gatewayAmount: 720` against the N$500 order.
 * It is the only multi-order settlement production has ever had.
 *
 * Substituting `settlementRows` into the loop would have fixed that instance and left two arrays
 * in scope, either of which type-checks in either position. So there is now ONE object --
 * `SettlementTarget` -- and the amount check and the writes both come off it;
 * `settle_order_payment` then locks those same rows, re-derives the expectation and writes them in
 * a single transaction, so a partial application is not reachable even on a mid-flight failure.
 *
 * THE METHOD IS THE GATEWAY'S (F3). This path is reached only when a card gateway has confirmed a
 * charge, so the method is `card` -- stated, not derived from `row.payment_method`, which is what
 * left real card payments recorded as cash.
 *
 * THE LEDGER ROW IS WRITTEN HERE (F2), inside that transaction, rather than by the device's
 * fire-and-forget `recordSaleEvent` afterwards. 1,630 paid card orders worth N$110,027 have no
 * `payment_events` row because the device was the only writer.
 */
async function applyGatewayConfirmedOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  orderIds: string[],
  params: {
    reference: string
    source: string
    extraAuditMetadata?: Record<string, unknown>
    /** The gateway-confirmed amount for this event, covering ALL orderIds combined. */
    gatewayAmount: number | null
    transactionId?: string | null
    intent?: ResolvedReference['intent']
  },
): Promise<GatewaySettlementOutcome> {
  if (!orderIds.length) {
    return { retryable: false, permanentRefusal: false, applied: false, claimedIds: [] }
  }

  const settled = await settleWholeOrderPayment(supabase, {
    // The webhook holds a bare gateway reference and no venue; it is derived from the orders, and
    // a target set spanning two venues is refused rather than narrowed.
    restaurantId: null,
    leadOrderIds: orderIds,
    intent: params.intent ?? null,
    merchantOrderNo: params.reference,
    transactionId: params.transactionId ?? null,
    gatewayAmount: params.gatewayAmount,
    paymentMethod: 'card',
    source: params.source,
    // The closed enum recordPaymentAmountMismatch keys on. Both webhook legs are one category
    // there by design -- a mismatch means the same thing whichever way the signature went.
    mismatchSource: 'paycloud_webhook',
    extraAuditMetadata: params.extraAuditMetadata,
  })

  if (settled.ok) {
    return {
      retryable: false,
      permanentRefusal: false,
      applied: settled.applied,
      claimedIds: settled.claimedOrderIds,
    }
  }

  /**
   * WHICH REFUSALS ARE WORTH RETRYING.
   *
   * `amount_mismatch` and `illegal_transition` will produce the identical answer on every future
   * delivery, so 503-ing forever only buries the event in Finatic's retry queue; both are already
   * recorded against every affected order for a human. Everything else -- an unreadable target, a
   * failed RPC, a tab that moved mid-flight -- is transient, and ACKing those would discard a real
   * payment with a success log.
   */
  const permanent = settled.reason === 'amount_mismatch' || settled.reason === 'illegal_transition'
  return {
    retryable: !permanent,
    permanentRefusal: permanent,
    applied: false,
    claimedIds: [],
    detail: settled.detail ?? settled.reason,
  }
}

/**
 * SETTLE AN ALLOCATION-SCOPE INTENT. THE ONE COPY, CALLED BY BOTH WEBHOOK PATHS.
 *
 * ==================================================================================================
 * WHY THIS IS A FUNCTION AND NOT A BRANCH
 * ==================================================================================================
 *
 * This logic used to live only on the signature-VALID path. The signature-FAILED fallback resolved
 * the same reference -- it already had `resolved.intent` in hand -- and then handed the order ids
 * straight to the WHOLE-ORDER writer (now applyGatewayConfirmedOrders).
 *
 * On 2026-09-07 that closed order #45 at Digi Cofee. A split card payment took N$17.00 of items
 * plus a N$20.00 gratuity; the gateway was charged N$37.00, which happened to equal the order
 * total, so the whole-order amount check saw no mismatch and marked all seven lines paid. N$17.00
 * of revenue was collected against an order recorded as N$37.00 paid, and the same N$20.00 was
 * counted once as a tip and again as revenue.
 *
 * A GRATUITY IS NOT ITEM SETTLEMENT. settleAllocationsForIntent settles exactly the intent's own
 * allocation ids and records the tip in payment_tips, so the two can never be added together to
 * reach "fully paid". `order_is_fully_paid_by_allocations` remains the sole authority on closing an
 * order. Nothing here compares the gateway amount to an order total, because for a part-order
 * charge that comparison is meaningless.
 *
 * SHARED RATHER THAN COPIED so the two paths cannot drift: a second copy is how the fallback came
 * to be missing the already-confirmed short-circuit as well as the scope fork.
 */
type AllocationIntentSupabase = Parameters<typeof settleAllocationsForIntent>[0]
type AllocationScopeIntent = Parameters<typeof settleAllocationsForIntent>[1]['intent']

async function settleAllocationScopeIntent(
  supabase: AllocationIntentSupabase,
  intent: AllocationScopeIntent,
  merchantOrderNo: string,
  source: string,
): Promise<Response> {
    if (intent.status === 'confirmed') {
      // Already settled, by the device or by an earlier delivery of this same webhook.
      console.log('[WEBHOOK] split payment already confirmed:', merchantOrderNo)
      return webhookAck()
    }
    if (intent.status === 'failed') {
      /**
       * THE GATEWAY SAYS PAID AND THE DEVICE SAID FAILED. The device's report is a claim about
       * what a reader displayed; this is the gateway's own record of money. It is NOT resolved
       * silently either way — the items are not settled on a failed intent, because releasing
       * and then settling would be two contradictory answers written a second apart, and a human
       * needs to see this.
       */
      console.error('[WEBHOOK] gateway reports paid for an intent the device reported FAILED', {
        merchantOrderNo,
        intentId: intent.id,
      })
      await supabase.from('audit_logs').insert({
        restaurant_id: intent.restaurantId,
        action: 'payment.split_intent_gateway_disagrees',
        entity_type: 'payment_intent',
        entity_id: intent.id,
        metadata: {
          merchantOrderNo,
          deviceOutcome: 'failed',
          gatewayOutcome: 'paid',
          allocationIds: intent.allocationIds,
          note: 'The gateway says this was paid and the terminal reported a failure. Items were NOT settled automatically. Reconcile against the gateway before taking payment again.',
        },
      })
      return webhookAck()
    }

    const settled = await settleAllocationsForIntent(supabase, {
      intent,
      paymentReference: merchantOrderNo,
      source,
    })

    if (!settled.ok) {
      /**
       * 503 SO FINATIC RETRIES. The charge is real and the items are still unsettled; the intent
       * is deliberately left holding them rather than being marked failed, so nothing releases
       * food that has been paid for.
       */
      console.error('[WEBHOOK] split settlement failed', {
        merchantOrderNo,
        intentId: intent.id,
        reason: settled.reason,
      })
      return NextResponse.json({ error: 'Split settlement failed' }, { status: 503 })
    }

    await markIntentConfirmed(supabase, intent.id)
    console.log('[WEBHOOK] split payment settled:', merchantOrderNo, {
      settled: settled.settledAllocationIds.length,
      ordersClosed: settled.ordersClosed.length,
      alreadySettled: settled.alreadySettled,
    })
    return webhookAck()
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

    /**
     * ============================================================================================
     * A SPLIT PAYMENT SETTLES ITEMS, NOT ORDERS.
     * ============================================================================================
     *
     * Every branch below this marks whole ORDERS paid, which is right for every reference that
     * existed before intents. For a part-order charge it would be catastrophic in the quiet way:
     * the reference names one diner's items, and closing the order would mark three other people's
     * food paid for by a card that never covered it.
     *
     * The fork is on `scope`, which only an intent can answer. Nothing reaching the code below has
     * one, so that path is untouched.
     *
     * SAME WRITER AS THE DEVICE. settleAllocationsForIntent is what
     * POST .../record-split-payment calls, and the two race by design: whichever proves the charge
     * first settles, and the other applies nothing and is told so. The RPC refuses an already-
     * settled allocation, which is what makes the race harmless.
     */
    if (resolved.intent && resolved.intent.scope === 'allocations') {
      return settleAllocationScopeIntent(
        supabase,
        resolved.intent,
        merchantOrderNo,
        'webhook/paycloud',
      )
    }

    if (!resolved.orderIds.length) {
      console.error(
        '[WEBHOOK] Order not found via orders or payment_events (returning 503 for retry):',
        merchantOrderNo,
      )
      return NextResponse.json({ error: 'Order not found' }, { status: 503 })
    }

    const settlement = await applyGatewayConfirmedOrders(supabase, resolved.orderIds, {
      reference: merchantOrderNo,
      source: 'paycloud_webhook_valid_signature',
      extraAuditMetadata: { businessOrderNo: merchantOrderNo, path },
      gatewayAmount: extractWebhookGatewayAmount(payload),
      transactionId: extractWebhookTransactionId(payload),
      // An orders-scope intent, when this reference was launched through one, DEFINES the target
      // set. An allocations-scope intent never reaches here -- it forked above.
      intent: resolved.intent,
    })
    if (settlement.retryable) {
      // NOT ACKed. Finatic must keep retrying: ACKing a payment we failed to record is how a real
      // charge is discarded with a success log.
      console.error(
        '[WEBHOOK] verified payment could not be applied (returning 503 for retry):',
        merchantOrderNo,
        settlement.detail,
      )
      return NextResponse.json(
        { error: 'Payment confirmed but not applied; retry later', detail: settlement.detail },
        { status: 503 },
      )
    }
    if (settlement.permanentRefusal) {
      // #223. Recorded on every affected order already. ACK rather than 503 -- Finatic will keep
      // sending the same disagreeing amount on retry, so there is nothing a retry can resolve;
      // a human resolves it from the audit trail.
      return webhookAck()
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

    /**
     * THE SAME FORK THE SIGNATURE-VALID PATH MAKES, AND FOR THE SAME REASON.
     *
     * Finatic has just independently confirmed this reference was paid, so the money is proven --
     * that is what makes settling here safe even though the signature did not verify. What is NOT
     * proven is that the charge covers a whole order: only the intent can answer that, and an
     * allocation-scope intent covers named items plus, separately, a gratuity.
     *
     * Reaching the whole-order writer with one of those is the defect that closed order #45.
     * After this, only whole-order references get there.
     */
    if (resolved.intent && resolved.intent.scope === 'allocations') {
      return settleAllocationScopeIntent(
        supabase,
        resolved.intent,
        merchantOrderNo,
        'webhook/paycloud-sig-fallback',
      )
    }

    const orderIds = fallback.orderIds.length ? fallback.orderIds : resolved.orderIds
    if (!orderIds.length) {
      return NextResponse.json({ error: 'Order not found' }, { status: 503 })
    }

    /**
     * THE SAME WRITER AS THE SIGNATURE-VALID LEG, and that is the point of it being one.
     *
     * [[webhook-has-two-paths-fork-both]]: a guard added to the signature-valid path was absent
     * from this one, and that is what cost order #45. Both legs now call the same function with
     * the same arguments, so a change to one cannot miss the other.
     *
     * This leg is where Riviera's N$720 actually arrived --
     * source 'paycloud_webhook_fallback_finatic_verified' is the value in production's audit row.
     */
    const settlement = await applyGatewayConfirmedOrders(supabase, orderIds, {
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
      transactionId: fallback.finatic.transactionId,
      intent: resolved.intent,
    })
    if (settlement.retryable) {
      // Finatic independently confirmed this payment. Failing to apply it and ACKing anyway is
      // exactly how a real payment gets discarded with a success log.
      console.error(
        '[WEBHOOK] Finatic-verified payment could not be applied (returning 503 for retry):',
        merchantOrderNo,
        settlement.detail,
      )
      return NextResponse.json(
        { error: 'Payment confirmed but not applied; retry later', detail: settlement.detail },
        { status: 503 },
      )
    }
    if (settlement.permanentRefusal) {
      // #223. Same reasoning as the signature-valid path: recorded already, and a retry cannot
      // change what Finatic reports for this reference.
      return webhookAck()
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
