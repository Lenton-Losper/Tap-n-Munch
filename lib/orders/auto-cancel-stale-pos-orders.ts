import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
  amountsMatch,
  GATEWAY_AMOUNT_TOLERANCE_CENTS,
} from '@/lib/payments/payment-integrity'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

export const STALE_POS_TIMEOUT_MS = 2 * 60 * 1000

/** Defensive throttle, not a documented Finatic limit -- caps outbound calls in one run. */
export const MAX_FINATIC_VERIFIED_PER_RUN = 20

type Supabase = ReturnType<typeof createServerSupabaseClient>

type StaleOrderCandidate = {
  id: string
  restaurant_id: string
  total: number
  paycloud_merchant_order_no: string | null
}

export type AutoCancelStalePosOrdersResult = {
  cancelledCount: number
  cancelledIds: string[]
  correctedToPaidCount: number
  correctedToPaidIds: string[]
  skippedUncertainCount: number
  skippedUncertainIds: string[]
  /**
   * Subset of skippedUncertainIds where Finatic specifically answered E04111 ("no record
   * of this merchant_order_no"), as opposed to being unreachable or erroring. Always a
   * subset -- these orders are skipped identically. Reported so a caller can tell the two
   * apart without re-probing Finatic.
   */
  e04111Ids: string[]
  /**
   * #223. Gateway confirmed a payment whose amount did not agree with the order total (or
   * carried no amount at all). NOT paid and NOT cancelled -- moved to a distinct
   * payment_status and left for a human. Reported separately so a caller can tell a hold
   * from an uncertain skip, which is the distinction that makes it visible.
   */
  heldForAmountReviewCount: number
  heldForAmountReviewIds: string[]
}

/**
 * #223 quarantine. A gateway-confirmed payment whose amount we could not agree.
 *
 * POSITIVELY IDENTIFIABLE, which is the requirement. The order moves to a distinct
 * payment_status, so it is queryable, it shows on the staff surfaces that read payment_status,
 * and -- because the sweep's candidate filter is `payment_status = 'pending'` -- it drops out of
 * the sweep instead of being re-held every two minutes. Contrast `skippedUncertain`, which leaves
 * the order `pending` and is therefore indistinguishable from an order the sweep has not reached
 * yet: that is the invisible-absence shape this must not copy.
 *
 * The audit row carries BOTH figures, so a human resolving it does not have to re-query Finatic
 * to see what the disagreement was.
 *
 * The `.eq('payment_status', 'pending')` re-assertion is the same concurrency guard cancelByIds
 * uses: a live terminal callback that resolved the order first wins, and this writes nothing.
 */
async function holdForAmountReview(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    merchantOrderNo: string
    gatewayAmount: number | null
    orderTotal: number
    transactionId: string | null
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('orders')
    .update({ payment_status: AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS })
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .eq('payment_status', 'pending')
    .select('id')

  if (error) throw error
  if (!data || data.length === 0) return false

  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: params.restaurantId,
    entity_type: 'order',
    entity_id: params.orderId,
    action: 'payment_amount_mismatch_held',
    metadata: {
      source: 'auto_cancel_cron_finatic_verified',
      merchantOrderNo: params.merchantOrderNo,
      transactionId: params.transactionId,
      // BOTH figures, named unambiguously. `gatewayAmount: null` means Finatic confirmed the
      // payment but returned no amount -- ABSENT is not AGREEING, and it is held for the same
      // reason a disagreeing figure is.
      gatewayAmount: params.gatewayAmount,
      orderTotal: params.orderTotal,
      reason:
        params.gatewayAmount === null
          ? 'Finatic confirmed a payment but returned no amount, so the amount was never verified.'
          : 'Finatic confirmed a payment whose amount does not equal the order total.',
    },
  })
  // A failed audit insert must not leave the hold unrecorded and the order silently moved.
  if (auditError) throw new Error(`holdForAmountReview audit: ${auditError.message}`)

  return true
}

async function cancelByIds(
  supabase: Supabase,
  ids: string[],
  cancellationReason: string = 'auto_timeout',
): Promise<string[]> {
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: cancellationReason,
    })
    .in('id', ids)
    .eq('payment_status', 'pending') // re-assert: a concurrent terminal callback wins the race
    .select('id')
  if (error) throw error
  return (data ?? []).map((row) => String(row.id))
}

/**
 * Cancels Sale-tab/terminal POS orders that sat at payment_status='pending' past the
 * stale timeout. Deliberately scoped to channel='pos' only -- other channels can
 * legitimately sit pending for a long time (pay-at-till), so a blanket filter would
 * wrongly cancel those too.
 *
 * Split by whether a Finatic payment attempt could have been initiated at all:
 *  - No paycloud_merchant_order_no at all: cancel immediately, no network call
 *    possible or needed -- this is the "genuinely abandoned" case. Safe at any timeout,
 *    because without a merchant order number prepare-payment never ran and no charge
 *    is possible.
 *  - paycloud_merchant_order_no present: cancelling on payment_status alone is
 *    exactly the bug behind the
 *    2026-07-27 FNB ChowNow incident (terminal device silence/false-failure caused
 *    real successful Finatic charges to get auto-cancelled). When verifyWithFinatic
 *    is true, each such order is checked against Finatic directly before any action:
 *      - Finatic confirms paid -> corrected to paid (markOrderPaidConfirmed), not cancelled.
 *      - Finatic confirms not paid -> cancelled, same as before.
 *      - Finatic unreachable/errors/credentials missing -> left untouched this run
 *        (never default to cancelling on an inconclusive check); retried next tick.
 *
 * verifyWithFinatic defaults to false so the terminal's own inline "lazy cleanup" call
 * (on every order-list poll -- see app/api/terminal/orders/route.ts) stays fast and
 * independent of Finatic's uptime; it only ever does the free, no-network branch above.
 * The Cloudflare cron (app/api/cron/cleanup-stale-orders/route.ts) is the only caller
 * that passes verifyWithFinatic: true and resolves the "initiated" bucket.
 */
export async function autoCancelStalePosOrders(
  supabase: Supabase,
  options?: {
    restaurantId?: string
    verifyWithFinatic?: boolean
    /** Test-only seam: override the Finatic query call. Defaults to the real implementation. */
    queryFinaticOrderPaidFn?: typeof queryFinaticOrderPaid
  },
): Promise<AutoCancelStalePosOrdersResult> {
  const {
    restaurantId,
    verifyWithFinatic = false,
    queryFinaticOrderPaidFn = queryFinaticOrderPaid,
  } = options ?? {}
  const cutoffIso = new Date(Date.now() - STALE_POS_TIMEOUT_MS).toISOString()

  const result: AutoCancelStalePosOrdersResult = {
    cancelledCount: 0,
    cancelledIds: [],
    correctedToPaidCount: 0,
    correctedToPaidIds: [],
    skippedUncertainCount: 0,
    skippedUncertainIds: [],
    e04111Ids: [],
    heldForAmountReviewCount: 0,
    heldForAmountReviewIds: [],
  }

  let candidateQuery = supabase
    .from('orders')
    .select('id, restaurant_id, total, paycloud_merchant_order_no')
    .eq('channel', 'pos')
    .eq('payment_status', 'pending')
    .lt('placed_at', cutoffIso)

  if (restaurantId) {
    candidateQuery = candidateQuery.eq('restaurant_id', restaurantId)
  }

  // #323: a GLOBAL sweep -- every stale pending POS order across every restaurant, with no upper
  // bound but the cutoff. Nine rows today; it grows with unpaid POS attempts, not with sales.
  const candidates = await fetchAllRows<{
    id: string
    restaurant_id: string
    total: number
    paycloud_merchant_order_no: string | null
  }>(candidateQuery, { label: 'autoCancelStalePosOrders' })
  if (candidates.length === 0) return result

  const rows = candidates as StaleOrderCandidate[]
  // The `payment.attempt_started` lookup that used to live here fed the removed E04111 cancel
  // gate (see the catch block below) and has no other consumer, so it goes with it rather than
  // sitting dead. PR2 should reintroduce it in the opposite direction: marker PRESENT means a
  // launch definitely happened, so SPARE that order from cancellation. Never the reverse.
  const noAttempt = rows.filter((o) => !String(o.paycloud_merchant_order_no || '').trim())
  const withAttempt = rows.filter((o) => String(o.paycloud_merchant_order_no || '').trim())

  result.cancelledIds.push(...(await cancelByIds(supabase, noAttempt.map((o) => o.id))))

  if (!verifyWithFinatic || withAttempt.length === 0) {
    result.cancelledCount = result.cancelledIds.length
    return result
  }

  const toProcess = withAttempt.slice(0, MAX_FINATIC_VERIFIED_PER_RUN)
  if (withAttempt.length > toProcess.length) {
    console.warn(
      `[autoCancelStalePosOrders] ${withAttempt.length - toProcess.length} stale in-flight order(s) deferred to next run (per-run cap ${MAX_FINATIC_VERIFIED_PER_RUN})`,
    )
  }

  for (const order of toProcess) {
    const orderId = String(order.id)
    const orderRestaurantId = String(order.restaurant_id)
    const merchantOrderNo = String(order.paycloud_merchant_order_no).trim()

    try {
      const { merchantNo, storeNo } = await getRestaurantFinaticCredentials(orderRestaurantId)
      const finaticResult = await queryFinaticOrderPaidFn({ merchantOrderNo, merchantNo, storeNo })

      if (finaticResult.paid) {
        // #223. This leg marked the order paid on Finatic's word with NO amount comparison at
        // all -- `finaticResult.amount ?? Number(order.total)` USES the gateway figure as the
        // written value and never asks whether it agrees. A confirmed N$20 payment marked an
        // N$200 order paid, issued a receipt for the order total, and the disagreeing figure
        // survived only in audit_logs.metadata.
        //
        // Gateway leg, so GATEWAY_AMOUNT_TOLERANCE_CENTS (zero) and ABSENT-is-not-AGREEING: if
        // Finatic did not give us an amount, we did not verify the amount.
        const gatewayAmount =
          typeof finaticResult.amount === 'number' && Number.isFinite(finaticResult.amount)
            ? finaticResult.amount
            : null
        const orderTotal = Number(order.total)
        const amountAgrees =
          gatewayAmount !== null &&
          amountsMatch(gatewayAmount, orderTotal, GATEWAY_AMOUNT_TOLERANCE_CENTS)

        if (!amountAgrees) {
          // QUARANTINE, ruled 2026-08-12. Not refuse, which every other writer does.
          //
          // Refusing here is the WORST of the three outcomes: the order stays `pending`, this
          // same sweep reaches it two minutes later, and cancels it -- on a card that has
          // already been charged. Cancelling a paid customer is worse than holding a figure we
          // cannot agree.
          //
          // So: do not mark paid, do NOT cancel, record BOTH figures, leave it for a human.
          const held = await holdForAmountReview(supabase, {
            orderId,
            restaurantId: orderRestaurantId,
            merchantOrderNo,
            gatewayAmount,
            orderTotal,
            transactionId: finaticResult.transactionId ?? null,
          })
          if (held) result.heldForAmountReviewIds.push(orderId)
          continue
        }

        const claim = await markOrderPaidConfirmed(supabase, {
          orderId,
          restaurantId: orderRestaurantId,
          reference: merchantOrderNo,
          voucherNo: finaticResult.transactionId || merchantOrderNo,
          /**
           * BOTH RULINGS, and they compose. Ruled 2026-08-17 after measuring.
           *
           * #223 — `amount: gatewayAmount`, never `?? Number(order.total)`. This line is only
           * reached when `amountAgrees`, so the gateway figure already equals the order total
           * within GATEWAY_AMOUNT_TOLERANCE_CENTS (zero); the fallback was only ever reachable in
           * the case that now quarantines. So #223 costs #268 nothing here.
           *
           * #268 — keep `gatewayAmount` as a FIRST-CLASS argument, not just audit metadata.
           * `markOrderPaidConfirmed` derives `amountMeaning: gatewayAmount != null ?
           * 'gateway_reported' : 'order_total'` from it. Dropping the argument COMPILES, because
           * the parameter is optional, and silently writes `amountMeaning: 'order_total'` for a
           * figure that came from the gateway — a false statement about provenance in the payment
           * audit trail, invisible to tsc and to every existing test. The #306 class, in the
           * ledger.
           */
          amount: gatewayAmount,
          gatewayAmount,
          source: 'auto_cancel_cron_finatic_verified',
          extraAuditMetadata: {
            correctionReason:
              'Order hit the stale-POS timeout with no confirmed terminal callback, but Finatic confirmed a successful payment before cancellation -- corrected instead of cancelled.',
            // #223: recorded on the AGREEING path too, so "we checked" is a fact in the row
            // rather than an inference from the absence of a hold.
            gatewayAmount,
            orderTotal,
            amountVerified: true,
          },
          fromPaymentStatuses: ['pending'],
        })
        if (claim.claimed) {
          result.correctedToPaidIds.push(orderId)
        }
        // claim.claimed === false just means something else (e.g. a live terminal
        // callback) resolved it concurrently -- not an error, nothing further to do.
      } else {
        const cancelled = await cancelByIds(supabase, [orderId])
        result.cancelledIds.push(...cancelled)
      }
    } catch (err) {
      // REMOVED 2026-08-05: a branch here cancelled with reason 'no_payment_attempt_made' when
      // Finatic answered E04111 AND no `payment.attempt_started` marker existed.
      //
      // The gate is empty in production: `payment.attempt_started` has been written ZERO times,
      // all time. So `!attemptStartedIds.has(orderId)` was true for 100% of orders and the rule
      // reduced to "E04111 -> cancel" on a SINGLE observation. E04111 is time-dependent --
      // order #149 returned it at 13:58:48 and was confirmed PAID on the same reference at
      // 13:59:10 -- so that is a mass-cancel of real payments. Measured blast radius at removal
      // time: 6 stale POS orders worth N$335 would have been cancelled on the first tick.
      //
      // Marker ABSENCE carries no information and must never authorise a cancel. Marker
      // PRESENCE is sound as a one-way guard and may be used to SPARE an order -- that
      // asymmetry is what PR2 should build on. The endpoint,
      // lib/payments/mark-payment-attempt-started.ts and migration
      // 20260728113000_orders_payment_attempt_started are deliberately kept for exactly that.
      // See docs/issue-attempt-started-marker-is-not-evidence.md.

      // Finatic unreachable, errored, or credentials missing -- no confident answer.
      // Never default to cancelling here; leave payment_status='pending' and retry next run.
      const e04111 = isFinaticMerchantOrderInvalidError(err)
      console.error(
        `[autoCancelStalePosOrders] Finatic check failed for order ${orderId} (restaurant ${orderRestaurantId}), skipping this run${e04111 ? ' [E04111 -- gateway has no record of this reference yet]' : ''}:`,
        err instanceof Error ? err.message : err,
      )
      result.skippedUncertainIds.push(orderId)
      // Classification only -- E04111 orders are still skipped, exactly as before. A single
      // E04111 is never terminal (#149 registered 22s later); deciding on persistence is
      // the separate auto-cancel pass's job. Surfaced here so that pass can reuse this run's
      // probe instead of querying Finatic a second time for the same order.
      if (e04111) result.e04111Ids.push(orderId)
    }
  }

  result.cancelledCount = result.cancelledIds.length
  result.correctedToPaidCount = result.correctedToPaidIds.length
  result.heldForAmountReviewCount = result.heldForAmountReviewIds.length
  result.skippedUncertainCount = result.skippedUncertainIds.length
  return result
}
