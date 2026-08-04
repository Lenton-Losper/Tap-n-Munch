import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

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
 * Split by whether a Finatic payment attempt was ever actually initiated:
 *  - No paycloud_merchant_order_no at all: cancel immediately, no network call
 *    possible or needed -- this is the "genuinely abandoned" case.
 *  - paycloud_merchant_order_no present but no payment.attempt_started marker:
 *    an order number was allocated, but we still do not know whether the device
 *    actually launched WiseCashier yet. This bucket is only confidently cancellable
 *    when Finatic explicitly answers E04111 (merchant order invalid).
 *  - payment.attempt_started marker present: cancelling on payment_status alone is
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

  const { data: candidates, error: candidatesError } = await candidateQuery
  if (candidatesError) throw candidatesError
  if (!candidates || candidates.length === 0) return result

  const rows = candidates as StaleOrderCandidate[]
  const candidateIds = rows.map((o) => String(o.id))
  const { data: attemptStartAudits, error: attemptStartAuditsError } = await supabase
    .from('audit_logs')
    .select('entity_id')
    .eq('entity_type', 'order')
    .eq('action', 'payment.attempt_started')
    .in('entity_id', candidateIds)
  if (attemptStartAuditsError) throw attemptStartAuditsError

  const attemptStartedIds = new Set(
    (attemptStartAudits ?? []).map((row) => String(row.entity_id || '')).filter(Boolean),
  )
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
        const claim = await markOrderPaidConfirmed(supabase, {
          orderId,
          restaurantId: orderRestaurantId,
          reference: merchantOrderNo,
          voucherNo: finaticResult.transactionId || merchantOrderNo,
          amount: finaticResult.amount ?? Number(order.total),
          source: 'auto_cancel_cron_finatic_verified',
          extraAuditMetadata: {
            correctionReason:
              'Order hit the stale-POS timeout with no confirmed terminal callback, but Finatic confirmed a successful payment before cancellation -- corrected instead of cancelled.',
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
      if (
        isFinaticMerchantOrderInvalidError(err) &&
        !attemptStartedIds.has(orderId)
      ) {
        const cancelled = await cancelByIds(supabase, [orderId], 'no_payment_attempt_made')
        result.cancelledIds.push(...cancelled)

        if (cancelled.length > 0) {
          const { error: auditError } = await supabase.from('audit_logs').insert({
            restaurant_id: orderRestaurantId,
            action: 'order.cancelled',
            entity_type: 'order',
            entity_id: orderId,
            metadata: {
              source: 'auto_cancel_cron_no_payment_attempt',
              cancellation_reason: 'no_payment_attempt_made',
              businessOrderNo: merchantOrderNo,
              correctionReason:
                'Cron queried Finatic for a stale POS order with an allocated merchant_order_no but no recorded payment-attempt-started marker. Finatic returned E04111 merchant order invalid, so the order was confidently treated as never having started a real payment attempt and cancelled.',
            },
          })
          if (auditError) {
            console.error(
              `[autoCancelStalePosOrders] audit log failed for no_payment_attempt_made cancel on order ${orderId}:`,
              auditError,
            )
          }
        }
        continue
      }

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
  result.skippedUncertainCount = result.skippedUncertainIds.length
  return result
}
