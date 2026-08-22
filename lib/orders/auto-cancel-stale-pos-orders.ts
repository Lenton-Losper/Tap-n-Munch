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

/**
 * How long a skipped order rests before Finatic is asked about it again.
 *
 * THE PROBLEM THIS SOLVES. An order that carries a paycloud_merchant_order_no and answers E04111 is
 * skipped, correctly, and then re-queried on the NEXT run two minutes later, and the one after
 * that, forever -- because the skip branch has no terminating condition. Ten such orders is roughly
 * 7,200 Finatic queries a day that cannot change anything. Measured 2026-08-21.
 *
 * ONE HOUR, and the rest interval is enforced by the audit row itself rather than by a new column:
 * the most recent payment.verification_skipped row IS the "last probed at" timestamp. That keeps
 * this migration-free and makes the rest interval auditable rather than invisible.
 *
 * THIS CHANGES NO DECISION. An order that is due for a probe is treated exactly as before; an order
 * that is not due is left untouched and reported separately. Nothing is cancelled, corrected or
 * resolved by this constant.
 */
export const SKIP_REPROBE_INTERVAL_MS = 60 * 60 * 1000

/** audit_logs.action written when an order is probed and no confident answer comes back. */
export const VERIFICATION_SKIPPED_ACTION = 'payment.verification_skipped'

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
   * Orders that were candidates but were NOT probed this run, because Finatic was already asked
   * about them within SKIP_REPROBE_INTERVAL_MS. Reported separately from skippedUncertainIds so a
   * quiet run is distinguishable from a run that probed and learned nothing.
   */
  deferredRecentlyProbedIds: string[]
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

/**
 * audit_logs.action written when this cron cancels an order. Deliberately the SAME action the
 * dashboard staff-cancel and the one-off operator scripts write, so every cancellation is found by
 * one query rather than three.
 */
export const ORDER_CANCELLED_ACTION = 'order.cancelled'

/** Which of this cron's two cancel paths decided. Recorded in the audit row, never in the order. */
export type CancelBasis = 'no_gateway_reference' | 'finatic_verified_not_paid'

const CANCEL_BASIS_NOTE: Record<CancelBasis, string> = {
  no_gateway_reference:
    'No paycloud_merchant_order_no was ever allocated, so prepare-payment never ran and no charge ' +
    'is possible. Cancelled without a gateway call, which is why none was recorded.',
  finatic_verified_not_paid:
    'Finatic was queried directly and returned a RECOGNISED not-paid status before this cancel. ' +
    'An unrecognised status does not reach here -- it is skipped, per the 2026-08-05 ruling.',
}

/**
 * THE CANCEL WRITES ITSELF DOWN. Ruled 2026-08-22.
 *
 * Until now this wrote the four order columns and nothing else. Measured on production the same
 * day: 95 of 272 cancelled orders carry NO audit row of any kind, and 90 of those are this
 * function's `auto_timeout`. So the single largest source of untracked cancellation in the system
 * was the automated one -- roughly ten times the incident that prompted the audit.
 *
 * The audit row goes INSIDE this function rather than at the two call sites, so a future third
 * caller cannot reintroduce a silent cancel by forgetting to add one.
 *
 * WHAT IS DELIBERATELY NOT CHANGED: `cancellation_reason`. Both paths still write 'auto_timeout'
 * exactly as before. That string is read by isCancelledOnE04111Evidence as a NON-recoverable
 * prefix, so changing it here would silently make these orders recoverable -- a money-path change
 * nobody ruled. The path that decided is recorded in the audit row's `basis` instead, which is
 * additive and reads nothing.
 *
 * A FAILED AUDIT INSERT THROWS, matching holdForAmountReview above. The orders are already
 * cancelled by then and throwing cannot undo that -- but a cancellation that went unrecorded is
 * precisely the defect being fixed, so it must not pass quietly.
 */
async function cancelByIds(
  supabase: Supabase,
  ids: string[],
  cancellationReason: string = 'auto_timeout',
  basis: CancelBasis = 'no_gateway_reference',
): Promise<string[]> {
  if (!ids.length) return []
  const cancelledAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancelled_at: cancelledAt,
      cancellation_reason: cancellationReason,
    })
    .in('id', ids)
    .eq('payment_status', 'pending') // re-assert: a concurrent terminal callback wins the race
    // restaurant_id is required for the audit row; total and the reference make the row readable
    // without joining back to orders.
    .select('id, restaurant_id, total, paycloud_merchant_order_no')
  if (error) throw error

  const cancelled = (data ?? []) as Array<{
    id: string
    restaurant_id: string
    total: number | null
    paycloud_merchant_order_no: string | null
  }>
  // Lost the race on every id: nothing was cancelled, so nothing is recorded.
  if (cancelled.length === 0) return []

  const { error: auditError } = await supabase.from('audit_logs').insert(
    cancelled.map((row) => ({
      restaurant_id: row.restaurant_id,
      entity_type: 'order',
      entity_id: String(row.id),
      action: ORDER_CANCELLED_ACTION,
      metadata: {
        source: 'auto_cancel_stale_pos_orders',
        automated: true,
        basis,
        basisNote: CANCEL_BASIS_NOTE[basis],
        cancellationReason,
        cancelledAt,
        orderTotal: row.total,
        businessOrderNo: row.paycloud_merchant_order_no ?? null,
      },
    })),
  )
  if (auditError) throw new Error(`cancelByIds audit: ${auditError.message}`)

  return cancelled.map((row) => String(row.id))
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
    deferredRecentlyProbedIds: [],
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

  /**
   * REST INTERVAL, applied BEFORE the per-run cap so the cap spends its budget on orders that are
   * actually due rather than on ones asked about minutes ago.
   *
   * The most recent payment.verification_skipped audit row is the "last probed at" timestamp. No
   * new column, no migration, and the interval is auditable because the evidence for it is the same
   * row a human would read.
   *
   * A read failure here DEFERS NOTHING -- `recentlyProbed` stays empty and every candidate is
   * probed exactly as before. Losing the rate cut is a cost; wrongly skipping an order because an
   * unrelated read failed would be a behaviour change, and this is not allowed to make one.
   */
  const recentlyProbed = new Set<string>()
  const priorSkipCounts = new Map<string, number>()
  try {
    const since = new Date(Date.now() - SKIP_REPROBE_INTERVAL_MS).toISOString()
    const { data: priorSkips } = await supabase
      .from('audit_logs')
      .select('entity_id, created_at')
      .eq('action', VERIFICATION_SKIPPED_ACTION)
      .in(
        'entity_id',
        withAttempt.map((o) => String(o.id)),
      )
    for (const row of priorSkips ?? []) {
      const id = String((row as { entity_id: string }).entity_id)
      priorSkipCounts.set(id, (priorSkipCounts.get(id) ?? 0) + 1)
      if (String((row as { created_at: string }).created_at) >= since) recentlyProbed.add(id)
    }
  } catch (probeReadErr) {
    console.error(
      '[autoCancelStalePosOrders] could not read prior skip audit rows; probing every candidate:',
      probeReadErr,
    )
  }

  const due = withAttempt.filter((o) => !recentlyProbed.has(String(o.id)))
  result.deferredRecentlyProbedIds.push(
    ...withAttempt.filter((o) => recentlyProbed.has(String(o.id))).map((o) => String(o.id)),
  )

  const toProcess = due.slice(0, MAX_FINATIC_VERIFIED_PER_RUN)
  if (due.length > toProcess.length) {
    console.warn(
      `[autoCancelStalePosOrders] ${due.length - toProcess.length} stale in-flight order(s) deferred to next run (per-run cap ${MAX_FINATIC_VERIFIED_PER_RUN})`,
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
      } else if (!finaticResult.statusRecognised) {
        /**
         * UNKNOWN STATUS NEVER AUTHORISES A CANCEL. Ruled 2026-08-22.
         *
         * `paid` is a boolean, so before this branch existed EVERY status that was not 2 fell
         * through to the cancel below -- including any value the gateway has never returned to us
         * before. Nobody has the enum: measured 2026-08-21, no vendor documentation of
         * trans_status exists on either drive, and only 1 and 2 have ever been observed in 43 live
         * calls. A 3 would have cancelled a real customer's order on a card that may have cleared.
         *
         * This is the same asymmetry the 2026-08-05 E04111 ruling established. An E04111 THROWS
         * and lands in the catch below, where it is skipped safely; an unrecognised status
         * returned successfully did not, and that gap is what this closes. Both now skip.
         *
         * IT IS RECORDED, NOT JUST SKIPPED. If Finatic ever returns a 3 the owner wants to find
         * out from the database, not from a cancelled customer order -- so the audit row names the
         * value verbatim.
         */
        const { error: unknownAuditError } = await supabase.from('audit_logs').insert({
          restaurant_id: orderRestaurantId,
          entity_type: 'order',
          entity_id: orderId,
          action: VERIFICATION_SKIPPED_ACTION,
          metadata: {
            source: 'auto_cancel_cron',
            businessOrderNo: merchantOrderNo,
            unrecognisedStatus: true,
            gatewayStatus: finaticResult.status,
            gatewayAmount: finaticResult.amount,
            reason:
              'Gateway answered with a trans_status this codebase does not recognise. Not cancelled: ' +
              'unknown is not not-paid. Recorded so the value can be found here rather than in a ' +
              'cancelled order.',
            observationCount: priorSkipCounts.get(orderId) ?? 0,
          },
        })
        if (unknownAuditError) {
          console.error(
            `[autoCancelStalePosOrders] unrecognised-status audit insert failed for order ${orderId}:`,
            unknownAuditError,
          )
        }
        console.warn(
          `[autoCancelStalePosOrders] order ${orderId}: UNRECOGNISED gateway status ${JSON.stringify(finaticResult.status)} -- skipping, not cancelling`,
        )
        result.skippedUncertainIds.push(orderId)
      } else {
        // Same cancellation_reason as before ('auto_timeout'); only the audit row records
        // that Finatic was asked and answered.
        const cancelled = await cancelByIds(
          supabase,
          [orderId],
          'auto_timeout',
          'finatic_verified_not_paid',
        )
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
      /**
       * WRITE THE SKIP DOWN. Part 2 of docs/design-persistence-pass-2026-08-21.md.
       *
       * Until now this path wrote nothing at all -- only a console.warn -- so NOTHING IN THE
       * DATABASE recorded whether the cron had looked at an order once or sixty times. That is
       * precisely why the #876 question could not be answered from data and had to be
       * reconstructed by reading this file.
       *
       * The row is also the rate-limit state: its created_at is the "last probed at" the block
       * above reads, so one write serves both purposes and neither needs a new column.
       *
       * BEST-EFFORT ON PURPOSE. A failed audit insert must not change what happens to the order --
       * it is still skipped, exactly as before. The consequence of losing a row is a lost
       * observation and an earlier re-probe, not a different decision about money.
       *
       * observationCount is the count BEFORE this row, so the first skip reads 0. The persistence
       * pass is specified to need span and count; this is where both come from.
       */
      const priorCount = priorSkipCounts.get(orderId) ?? 0
      const { error: skipAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: orderRestaurantId,
        entity_type: 'order',
        entity_id: orderId,
        action: VERIFICATION_SKIPPED_ACTION,
        metadata: {
          source: 'auto_cancel_cron',
          businessOrderNo: merchantOrderNo,
          gatewayCode: e04111 ? 'E04111' : null,
          isE04111: e04111,
          reason: err instanceof Error ? err.message : String(err),
          observationCount: priorCount,
          reprobeIntervalMs: SKIP_REPROBE_INTERVAL_MS,
        },
      })
      if (skipAuditError) {
        console.error(
          `[autoCancelStalePosOrders] skip audit insert failed for order ${orderId}:`,
          skipAuditError,
        )
      }

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
