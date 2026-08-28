import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  AMOUNT_MISMATCH_HOLD_PAYMENT_STATUS,
  amountsMatch,
  GATEWAY_AMOUNT_TOLERANCE_CENTS,
  VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS,
} from '@/lib/payments/payment-integrity'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import {
  CANCEL_BASIS_NOTE,
  ORDER_CANCELLED_ACTION,
  type CancelBasis,
} from './cancel-order-with-trail'

/**
 * How long a POS order may sit at payment_status='pending' before it becomes a CANDIDATE.
 *
 * THIS DECIDES CANDIDACY ONLY, NEVER AN OUTCOME. Every branch below except "no merchant order
 * number" re-verifies against Finatic before doing anything. That is what makes the value safe,
 * and it is the property to preserve: the moment any rule cancels on elapsed time alone, this
 * number starts deciding money.
 *
 * NOW MEASURED, 2026-08-26 on production. The 2026-08-05 audit had to take a ~57 s median on
 * faith because "no transaction-duration telemetry exists anywhere". It exists now:
 * orders.payment_attempt_started_at -> paid_at, written by the same marker whose absence that
 * audit was reasoning about. Over 894 real settled POS payments:
 *
 *   p50 14.9 s   p75 19.6 s   p90 25.9 s   p95 32.4 s   p99 54.7 s   max 283.8 s
 *
 * So 120 s is ~8x the median and ~2.2x the p99 -- a far wider margin than the ~2.1x the audit
 * assumed, and the "thin margin" concern recorded there does not survive the measurement.
 *
 * THE TAIL IS REAL THOUGH. 3 of those 894 settled AFTER 120 s (0.3%), the slowest at 283.8 s.
 * They came to no harm because Finatic was asked. Under a cancel-on-elapsed-time rule those
 * three would have been three cancelled real payments in three weeks, which is the concrete
 * cost of the change this docblock warns against.
 */
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

/**
 * #153. audit_logs.action written when an order is moved OUT of the retry loop because the venue
 * has no Finatic credentials, so the question can never be answered.
 *
 * A distinct action, not a `payment.verification_skipped` row with a flag. The skip action means
 * "asked, no confident answer, will ask again"; this one means "will not ask again". Counting
 * them together is what made 743 rows over 18 orders look like activity instead of a stall.
 */
export const VERIFICATION_UNAVAILABLE_HELD_ACTION = 'payment.verification_unavailable_held'

/**
 * #153. audit_logs.action written when a held order is returned to the sweep because its venue
 * now HAS credentials. The hold's exit, recorded, so a status that changed by itself is
 * explicable from the row rather than from this file.
 */
export const VERIFICATION_UNAVAILABLE_RELEASED_ACTION = 'payment.verification_unavailable_released'

type Supabase = ReturnType<typeof createServerSupabaseClient>

type StaleOrderCandidate = {
  id: string
  restaurant_id: string
  total: number
  channel: string | null
  paycloud_merchant_order_no: string | null
}

/**
 * #353 — a stale order this sweep can SEE but must never act on.
 *
 * Carries the figures a caller needs to report it without a second query, because the point of
 * surfacing is that somebody finds out.
 */
export type SurfacedStaleOrder = {
  id: string
  restaurantId: string
  channel: string
  total: number
  hasGatewayReference: boolean
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
  /**
   * #153. Orders taken OUT of the retry loop because the venue has no Finatic credentials, so no
   * future run could answer the question either. Not cancelled -- moved to a distinct
   * payment_status and left for a human. A strict NON-subset of skippedUncertainIds: an order
   * counted here was NOT skipped, because skipping is what this replaces.
   */
  heldVerificationUnavailableCount: number
  heldVerificationUnavailableIds: string[]
  /**
   * #153. Previously held orders returned to `pending` because their venue now HAS credentials,
   * so the ordinary sweep can verify them again. The hold's exit; see
   * releaseHeldVerificationUnavailable.
   */
  releasedVerificationUnavailableCount: number
  releasedVerificationUnavailableIds: string[]
  /**
   * #353. Stale pending orders on a channel this sweep does NOT act on. Seen, reported, and
   * otherwise untouched: not cancelled, not probed, not written to in any way.
   *
   * WHY VISIBILITY WIDENS BUT THE CANCEL DOES NOT. Measured on production 2026-08-27, the stale
   * pending population was:
   *
   *     channel   stuck   avg days   oldest   no gateway reference
   *     pos           7       10.9     14.4    0 of 7
   *     table         9        3.3      8.0    9 of 9
   *     kiosk         4       33.8     40.6    3 of 4
   *
   * The sweep saw seven of twenty, and the thirteen it could not see were stuck THREE TIMES
   * LONGER, with nothing anywhere looking for them. Eleven of those thirteen carry no
   * paycloud_merchant_order_no at all.
   *
   * That last figure is exactly why the filter alone must not be widened. Every branch below the
   * partition assumes a POS/Finatic shape: a merchant order number to quote, a gateway to ask,
   * and E04111 as the discriminator between "no record yet" and "no record ever". An order with
   * no reference cannot be verified by anything, so the no-reference branch cancels it outright
   * on the reasoning that prepare-payment never ran. On a POS order that reasoning holds. On a
   * `table` order it does not: those are pay-at-till, they legitimately never had a gateway
   * reference, and eleven of them are `ready`, `preparing` or `completed` — the food was made.
   * Cancelling them would write off real debt on a rule imported from another channel.
   *
   * So these are SURFACED, and the surface is components/held-for-review-panel.tsx. This field
   * exists so a cron run also says the number out loud; it is not the customer of it.
   */
  surfacedNeedsHumanCount: number
  surfacedNeedsHumanIds: string[]
  surfacedNeedsHuman: SurfacedStaleOrder[]
  /**
   * Orders left alone because they sit on an OPEN TAB — a meal in progress, not a dead payment.
   * Counted rather than dropped silently: a sweep that quietly skips rows is indistinguishable
   * from a sweep whose query is broken.
   */
  skippedOpenTabCount: number
  skippedOpenTabIds: string[]
}

/**
 * The one channel whose stale pending orders this sweep may cancel or verify.
 *
 * Named rather than written as a bare `'pos'` at the partition, so the blast radius of the
 * cancel path is greppable and a future channel cannot be swept into it by an edit to a query.
 */
export const SWEEP_ACTIONABLE_CHANNEL = 'pos'

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
export async function holdForAmountReview(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    merchantOrderNo: string
    gatewayAmount: number | null
    orderTotal: number
    transactionId: string | null
    /**
     * Which writer held it. DEFAULTS TO THE CRON'S OWN TAG, unchanged byte for byte, because
     * production audit rows already carry that value and a second writer must not retroactively
     * relabel them. `lib/orders/clear-held-for-review.ts` passes its own.
     */
    source?: string
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
      source: params.source ?? 'auto_cancel_cron_finatic_verified',
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
 * #153 quarantine. The venue has no Finatic credentials, so this order's reference cannot be
 * queried -- not on this run and not on any future one.
 *
 * SHAPED EXACTLY LIKE holdForAmountReview ABOVE, deliberately, because it is the same problem
 * one cause along: an outcome that leaves the order `pending` is an ABSENCE, indistinguishable
 * from an order the sweep has not reached yet, and it is re-probed forever. Moving the order to a
 * distinct payment_status makes it queryable, puts it on the staff surfaces that read
 * payment_status, and drops it out of the sweep's `payment_status = 'pending'` filter for free --
 * which is what actually terminates the loop.
 *
 * WHAT IT DOES NOT DO IS CANCEL. Nothing here establishes that no charge exists. The device-side
 * WiseCashier flow charges under the reader's own merchant, which this system never records, so
 * an empty credentials column is not evidence of an uncharged card. The recorded precedent is
 * Digi Cofee #19, resolved by hand with a cancellation_reason that says so explicitly.
 *
 * A FAILED AUDIT INSERT THROWS, matching holdForAmountReview: a status moved with no record is
 * the invisible-change defect this exists to end, so it must not pass quietly. The throw lands in
 * the caller's catch, which skips the order -- the previous behaviour -- rather than losing it.
 *
 * The `.eq('payment_status', 'pending')` re-assertion is the same concurrency guard the other two
 * writers use: a live terminal callback that resolved the order first wins, and this writes
 * nothing.
 */
async function holdForVerificationUnavailable(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    merchantOrderNo: string
    orderTotal: number
    observationCount: number
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('orders')
    .update({ payment_status: VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS })
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
    action: VERIFICATION_UNAVAILABLE_HELD_ACTION,
    metadata: {
      source: 'auto_cancel_cron',
      businessOrderNo: params.merchantOrderNo,
      orderTotal: params.orderTotal,
      // How many times this order had already been probed to no effect before the loop was
      // noticed. On production this reached 93 for orders in the sibling E04111 case.
      priorSkipCount: params.observationCount,
      chargeStatus: 'unknown',
      reason:
        'This restaurant has no Finatic merchant/store credentials, so the gateway cannot be ' +
        'asked about this order and no future run could answer either. Taken out of the retry ' +
        'loop. NOT cancelled: an absent credential is not evidence that no card was charged -- ' +
        'the device-side flow charges under the reader\'s own merchant, which is not recorded ' +
        'here. Returns to the sweep automatically once credentials are configured.',
    },
  })
  if (auditError) throw new Error(`holdForVerificationUnavailable audit: ${auditError.message}`)

  return true
}

/**
 * #153. The hold's EXIT. Returns held orders to `pending` once their venue has credentials, so
 * the ordinary sweep verifies them on the same run.
 *
 * WITHOUT THIS the fix trades a forever-retry for a forever-hold, which is the same defect with a
 * better name. The live shape of #153 is not a credential CHANGE (that is #152) but a venue
 * onboarded before its credentials are entered -- 8 of 11 production venues have none today, and
 * Chownow Nedbank is sitting in that state right now with zero orders. For that venue the hold
 * must end by itself the day ops fills the fields in, without anyone knowing these rows exist.
 *
 * SAFE BY CONSTRUCTION. It only ever moves HOLD -> pending, which is where the order came from,
 * and the guard `.eq('payment_status', HOLD)` means it can only affect a row this function's
 * counterpart put there. It writes no money column and makes no decision about a charge; the
 * decision is handed back to the sweep, which will now genuinely be able to ask.
 *
 * BEST-EFFORT, and the caller must treat a throw as "released nothing". A failure here has to
 * leave the run behaving exactly as it did before this function existed.
 */
async function releaseHeldVerificationUnavailable(
  supabase: Supabase,
  restaurantId?: string,
): Promise<string[]> {
  let query = supabase
    .from('orders')
    .select('id, restaurant_id, total, paycloud_merchant_order_no')
    .eq('payment_status', VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
  if (restaurantId) query = query.eq('restaurant_id', restaurantId)

  /**
   * Its OWN row type, not StaleOrderCandidate. #353 added `channel` to that type because the
   * candidate query now selects it; this select does not, and fetchAllRows' generic is an
   * unchecked cast, so reusing it would have declared a column that is always undefined here.
   *
   * NO channel filter belongs on this read either. A held order is by construction one the sweep
   * itself held, and the hold only ever happens on the POS path -- but the release must return
   * whatever it finds in the hold status regardless, because a row this function refuses to
   * release is a row nothing else will.
   */
  const held = await fetchAllRows<{
    id: string
    restaurant_id: string
    total: number
    paycloud_merchant_order_no: string | null
  }>(query, {
    label: 'releaseHeldVerificationUnavailable',
  })
  if (held.length === 0) return []

  // One credential lookup per RESTAURANT, not per order. The lookup is cached, but a venue with a
  // long backlog of held orders should not be able to turn a release pass into N reads.
  const credentialsNow = new Map<string, boolean>()
  for (const rid of new Set(held.map((o) => String(o.restaurant_id)))) {
    try {
      await getRestaurantFinaticCredentials(rid)
      credentialsNow.set(rid, true)
    } catch (err) {
      /**
       * ANY throw means "do not release", and the two reasons are worth keeping apart in the log
       * even though they take the same action.
       *
       * A MISSING-credentials throw is the ordinary case: the hold's cause still holds, so the
       * order stays held and nothing is written. Any OTHER throw -- a failed cache/DB read -- is
       * an UNKNOWN, and unknown must not release either: handing the order back to the sweep on
       * the strength of a read that failed would let it be cancelled on a Finatic answer that
       * could not really have been obtained. Staying held is the outcome that costs nothing.
       */
      credentialsNow.set(rid, false)
      if (!isMissingFinaticCredentialsError(err)) {
        console.error(
          `[releaseHeldVerificationUnavailable] credential read failed for restaurant ${rid}; leaving its orders held:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  const released: string[] = []
  for (const order of held) {
    const orderId = String(order.id)
    const orderRestaurantId = String(order.restaurant_id)
    if (!credentialsNow.get(orderRestaurantId)) continue

    const { data, error } = await supabase
      .from('orders')
      .update({ payment_status: 'pending' })
      .eq('id', orderId)
      .eq('restaurant_id', orderRestaurantId)
      .eq('payment_status', VERIFICATION_UNAVAILABLE_HOLD_PAYMENT_STATUS)
      .select('id')
    if (error) throw error
    if (!data || data.length === 0) continue

    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: orderRestaurantId,
      entity_type: 'order',
      entity_id: orderId,
      action: VERIFICATION_UNAVAILABLE_RELEASED_ACTION,
      metadata: {
        source: 'auto_cancel_cron',
        businessOrderNo: order.paycloud_merchant_order_no ?? null,
        orderTotal: order.total ?? null,
        reason:
          'The restaurant now has Finatic credentials, so this order can be verified again. ' +
          'Returned to payment_status=pending for the ordinary sweep. No money column was ' +
          'written and no conclusion about a charge was drawn.',
      },
    })
    if (auditError) {
      throw new Error(`releaseHeldVerificationUnavailable audit: ${auditError.message}`)
    }

    released.push(orderId)
  }

  return released
}

// The cancel action, the basis vocabulary and its notes live in the shared helper now,
// because the terminal status route must write the IDENTICAL row. Re-exported here so
// existing importers keep their path.
export { ORDER_CANCELLED_ACTION }
export type { CancelBasis }


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
 * stale timeout.
 *
 * #353 SPLIT VISIBILITY FROM ACTION. Until 2026-08-27 the candidate query itself carried
 * `.eq('channel','pos')`, so the other channels were not merely spared -- they were INVISIBLE,
 * and nothing else in the system looked for them either. Measured that day: the sweep saw 7 of
 * 20 stale pending orders, and the 13 it could not see had been stuck three times longer, the
 * oldest for 40.6 days.
 *
 * The query now reads EVERY channel and the `pos` filter has moved to the partition. Non-POS
 * orders are reported in `surfacedNeedsHuman` and are otherwise untouched: not cancelled, not
 * probed, not written to. The cancel path below still assumes a POS/Finatic shape -- a merchant
 * order number, a gateway that can be asked, E04111 as the discriminator -- and 11 of those 13
 * orders carry no gateway reference at all, so widening the filter alone would have cancelled
 * orders that could never have been verified. The staff surface is where they get resolved; see
 * lib/orders/held-for-review.ts.
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
    heldVerificationUnavailableCount: 0,
    heldVerificationUnavailableIds: [],
    releasedVerificationUnavailableCount: 0,
    releasedVerificationUnavailableIds: [],
    surfacedNeedsHumanCount: 0,
    surfacedNeedsHumanIds: [],
    surfacedNeedsHuman: [],
    skippedOpenTabCount: 0,
    skippedOpenTabIds: [],
  }

  /**
   * #153. The release pass runs FIRST, and before the `candidates.length === 0` early return
   * below -- both positions are load-bearing.
   *
   * Running first means a released order re-enters the candidate query on THIS run rather than
   * waiting two minutes. Running before the early return means the pass still happens on a run
   * with no stale candidates at all, which is the ordinary case for a quiet venue and would
   * otherwise leave its held orders held indefinitely.
   *
   * GATED ON verifyWithFinatic. The terminal's inline lazy-cleanup call must stay on the free,
   * no-network branch, and releasing an order into a sweep that will not verify it is pointless
   * anyway.
   *
   * THE CATCH IS THE POINT. A failure here must leave the run behaving exactly as it did before
   * this existed: nothing released, everything else unchanged.
   */
  if (verifyWithFinatic) {
    try {
      const released = await releaseHeldVerificationUnavailable(supabase, restaurantId)
      result.releasedVerificationUnavailableIds.push(...released)
      if (released.length > 0) {
        console.log(
          `[autoCancelStalePosOrders] released ${released.length} order(s) from verification-unavailable hold (credentials now configured)`,
        )
      }
    } catch (releaseErr) {
      console.error(
        '[autoCancelStalePosOrders] verification-unavailable release pass failed; nothing released:',
        releaseErr,
      )
    }
  }

  /**
   * #353 — NO `.eq('channel', 'pos')` HERE ANY MORE, and `channel` is now selected.
   *
   * The filter moved DOWN, to the partition below, and the difference is the whole change: a
   * channel filter on the query makes the other channels invisible, a channel filter on the
   * ACTION makes them visible and untouched. The cancel and verify paths are unchanged and still
   * see only `pos`.
   */
  let candidateQuery = supabase
    .from('orders')
    // `tab_id` is selected for the open-tab exclusion immediately below. Without it every
    // waiter-led round looks exactly like an abandoned POS payment.
    .select('id, restaurant_id, total, channel, tab_id, paycloud_merchant_order_no')
    .eq('payment_status', 'pending')
    .lt('placed_at', cutoffIso)

  if (restaurantId) {
    candidateQuery = candidateQuery.eq('restaurant_id', restaurantId)
  }

  // #323: a GLOBAL sweep -- every stale pending order across every restaurant, with no upper
  // bound but the cutoff. Twenty rows today; it grows with unpaid attempts, not with sales.
  const candidates = await fetchAllRows<{
    id: string
    restaurant_id: string
    total: number
    channel: string | null
    tab_id: string | null
    paycloud_merchant_order_no: string | null
  }>(candidateQuery, { label: 'autoCancelStalePosOrders' })
  if (candidates.length === 0) return finalise(result)

  /**
   * ============================================================================================
   * AN UNPAID ORDER ON AN OPEN TAB IS A MEAL IN PROGRESS, NOT A DEAD PAYMENT ATTEMPT.
   * ============================================================================================
   *
   * On 2026-08-28 this sweep cancelled three live rounds at Digi Cofee, Table 1 — orders #30,
   * #31 and #32 — between two and three minutes after each was placed. `cancellation_reason`
   * on all three reads `auto_timeout`. The kitchen had already cooked them: their lines were
   * `kitchen_state = 'ready'` against orders the database had marked cancelled. Food left the
   * pass for orders that could never be billed, and nothing on the terminal said so.
   *
   * WHY IT HAPPENED. A waiter-led round writes `channel: 'pos'` and `payment_status: 'pending'`,
   * because it is unpaid — and it stays unpaid for the whole meal, by design, until someone
   * settles the tab. That is indistinguishable, on this query alone, from a POS payment the
   * customer walked away from. The sweep is right about the shape and wrong about the meaning.
   *
   * WHY NOT SIMPLY A LONGER TIMEOUT. Because a two-hour dinner is not a slower payment; it is a
   * different lifecycle. Any timeout long enough to survive a real service is far too long to
   * catch the abandoned card payment this sweep exists for, and it would still cancel the meal
   * that ran long. The discriminator has to be the tab, not the clock.
   *
   * WHAT COUNTS AS PROTECTED: the order belongs to a tab whose status is still `open`. A tab
   * that has been closed or settled no longer protects its orders, so a genuinely abandoned
   * attempt on a finished tab is still swept.
   *
   * This deliberately protects QR-opened tabs too. An unpaid order on any open tab is a meal
   * somebody is still having. Sweeping abandoned QR tabs is a separate question with its own
   * threshold to measure (#366) and is not something to smuggle in here.
   *
   * FAILURE POSTURE: if the tabs read fails, NOTHING is swept this run. The alternative —
   * proceeding with an empty protected set — cancels live meals whenever a query hiccups, which
   * is precisely the outcome being fixed.
   */
  const candidateTabIds = [
    ...new Set(
      candidates
        .map((row) => String(row.tab_id ?? '').trim())
        .filter((id) => id.length > 0),
    ),
  ]

  const openTabIds = new Set<string>()
  if (candidateTabIds.length > 0) {
    const { data: openTabs, error: openTabsError } = await supabase
      .from('tabs')
      .select('id')
      .in('id', candidateTabIds)
      .eq('status', 'open')

    if (openTabsError) {
      console.error(
        '[autoCancelStalePosOrders] REFUSING TO SWEEP: could not read tabs, so a live meal ' +
          'cannot be told from an abandoned payment.',
        openTabsError,
      )
      return finalise(result)
    }

    for (const tab of (openTabs ?? []) as Array<{ id: unknown }>) {
      openTabIds.add(String(tab.id))
    }
  }

  const protectedByOpenTab = candidates.filter((row) =>
    openTabIds.has(String(row.tab_id ?? '')),
  )
  for (const row of protectedByOpenTab) {
    result.skippedOpenTabIds.push(String(row.id))
  }
  result.skippedOpenTabCount = result.skippedOpenTabIds.length

  const allRows = candidates.filter(
    (row) => !openTabIds.has(String(row.tab_id ?? '')),
  ) as StaleOrderCandidate[]
  if (allRows.length === 0) return finalise(result)

  /**
   * THE PARTITION. Everything below this line still operates on POS orders only.
   *
   * `rows` is deliberately reassigned to the POS subset rather than the whole candidate set, so
   * that `noAttempt`, `withAttempt`, the Finatic loop and both cancel call sites are reached by
   * exactly the orders they were reached by before this change. A non-POS order cannot enter any
   * of them without an edit here.
   *
   * Channel is compared after trim+lowercase: it is free text, and a stray 'POS' must not fall
   * out of the actionable set and start being merely surfaced instead -- that would be a silent
   * behaviour change on the money path, in the safe-looking direction.
   */
  const channelOf = (row: StaleOrderCandidate) =>
    String(row.channel ?? '')
      .trim()
      .toLowerCase()

  const rows = allRows.filter((row) => channelOf(row) === SWEEP_ACTIONABLE_CHANNEL)

  for (const row of allRows) {
    if (channelOf(row) === SWEEP_ACTIONABLE_CHANNEL) continue
    result.surfacedNeedsHuman.push({
      id: String(row.id),
      restaurantId: String(row.restaurant_id),
      channel: channelOf(row) || '(none)',
      total: Number(row.total),
      hasGatewayReference: String(row.paycloud_merchant_order_no ?? '').trim() !== '',
    })
  }
  result.surfacedNeedsHumanIds = result.surfacedNeedsHuman.map((o) => o.id)

  /**
   * #353 + #153, MERGED 2026-08-27: `finalise`, not a bare `return result`.
   *
   * This is a THIRD early return, added by #353 after #153 introduced finalise() precisely
   * because early returns were reporting zero for counts whose id lists were non-empty. It is the
   * most exposed of the three: the release pass runs BEFORE it, so a run whose only stale
   * candidates were non-POS would report `releasedVerificationUnavailable: 0` having just
   * released orders, and would report `surfacedNeedsHuman: 0` having just surfaced them.
   */
  if (rows.length === 0) return finalise(result)
  // The `payment.attempt_started` lookup that used to live here fed the removed E04111 cancel
  // gate (see the catch block below) and has no other consumer, so it goes with it rather than
  // sitting dead.
  //
  // It is NOT coming back. The note that used to sit here told PR2 to reintroduce it inverted --
  // marker PRESENT spares the order -- on the reasoning that the gate was only useless because
  // nothing wrote the marker. Terminals write it now (1,009 rows since 2026-08-06) and it is
  // still useless: 7 of the 7 currently stuck orders carry one, against 94.5% of paid orders, so
  // it spares everything and distinguishes nothing. Full measurement in the catch block below.
  const noAttempt = rows.filter((o) => !String(o.paycloud_merchant_order_no || '').trim())
  const withAttempt = rows.filter((o) => String(o.paycloud_merchant_order_no || '').trim())

  result.cancelledIds.push(...(await cancelByIds(supabase, noAttempt.map((o) => o.id))))

  if (!verifyWithFinatic || withAttempt.length === 0) {
    return finalise(result)
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
      // WHY IT WAS REMOVED, as measured on 2026-08-05: the gate was empty. `payment.attempt_started`
      // had been written zero times in production, so `!attemptStartedIds.has(orderId)` was true for
      // 100% of orders and the rule reduced to "E04111 -> cancel" on a SINGLE observation. E04111 is
      // time-dependent -- order #149 returned it at 13:58:48 and was confirmed PAID on the same
      // reference at 13:59:10 -- so that is a mass-cancel of real payments. Blast radius at removal
      // time: 6 stale POS orders worth N$335 on the first tick.
      //
      // ------------------------------------------------------------------------------------------
      // THE "ZERO TIMES" HALF EXPIRED ON 2026-08-06 AND THIS COMMENT DID NOT. Corrected 2026-08-26.
      //
      // The marker is populated and has been since the day after the removal. Measured on
      // production 2026-08-26: 1,009 `payment.attempt_started` rows, exactly one per order,
      // 2026-08-06 through today, across four venues, every one `source: 'terminal_app'` from APK
      // 1.75/1.78/1.85/1.89/1.97. The endpoint is live and terminals call it.
      //
      // THE REMOVAL IS STILL CORRECT. Only its evidence changed, and the replacement is stronger
      // because it does not expire:
      //
      //   1. Absence still proves nothing about the world. The terminal's
      //      notifyPaymentAttemptStarted races a 2 s timeout and swallows every failure, and
      //      launchPayment is started FIRST -- so a card can be charged with no marker ever
      //      written. That is correct for a payment path and disqualifying for evidence. No
      //      amount of adoption fixes it.
      //   2. The marker is now measured NOT to discriminate. POS orders placed on/after
      //      2026-08-06: paid carry it 94.5% of the time (893/945), cancelled 74.3% (107/144),
      //      and the stale-pending backlog 100% (7/7). Marker presence is *more* common on stuck
      //      orders than on paid ones. It separates neither population from the other.
      //
      // SO DO NOT BUILD PR2's "marker PRESENT spares the order" GATE. Earlier notes here and in
      // docs/stale-pending-inventory-2026-08-21.md recommended it on the assumption that adoption
      // would make the asymmetry usable. Adoption arrived; the asymmetry did not. All 7 orders in
      // today's stuck backlog carry a marker, so a spare-gate spares 7 of 7 and changes nothing --
      // it would be pure decoration in front of the decision that actually matters.
      //
      // What PR2 still needs is unchanged and is NOT about this marker: persistence across a long
      // window (the payment.verification_skipped rows below are that record -- 93 observations each
      // spanning four days on the current 7), a same-run positive control, and a volume circuit
      // breaker. See docs/issue-attempt-started-marker-is-not-evidence.md, whose headline claim
      // carries the same expired measurement and the same correction.
      //
      // mark-payment-attempt-started.ts and migration 20260728113000_orders_payment_attempt_started
      // stay, but for their own sake, not for this gate: payment_attempt_started_at is the only
      // payment-duration telemetry that exists. It is what makes STALE_POS_TIMEOUT_MS checkable
      // against real data -- see the constant's docblock.
      // ------------------------------------------------------------------------------------------

      /**
       * #153 -- THREE CONDITIONS, NOT ONE. This comment used to read "Finatic unreachable,
       * errored, or credentials missing -- no confident answer", and answered all three the same
       * way: leave `pending`, retry next run.
       *
       * For unreachable and errored that is right. Both are transient; the next run may well get
       * an answer, and never defaulting to a cancel on an inconclusive check is the rule the FNB
       * ChowNow incident wrote.
       *
       * For CREDENTIALS MISSING it is a permanent loop. The retry is waiting on something
       * external to change, and nothing external is involved -- the venue simply has no Finatic
       * merchant/store pair, so the query cannot be formed, this run or any run. Measured on
       * production 2026-08-26: the sibling E04111 case had reached 93 re-probes per order across
       * four days with nothing resolved, and the credentials case's one realised instance (Digi
       * Cofee #19) sat `pending` for nine days until a human cancelled it by hand.
       *
       * So it is discriminated HERE, first, before the skip is written. What follows is unchanged
       * for the other two.
       */
      if (isMissingFinaticCredentialsError(err)) {
        console.warn(
          `[autoCancelStalePosOrders] order ${orderId}: restaurant ${orderRestaurantId} has no Finatic ` +
            'credentials -- the gateway cannot be asked, now or ever. Holding for review instead of ' +
            'retrying forever. NOT cancelled: charge status is unknown, not absent.',
        )
        /**
         * WE ARE ALREADY INSIDE THE CATCH, so a throw from the hold has nowhere to land and would
         * abandon the remaining orders in the run. holdForVerificationUnavailable throws
         * deliberately when its audit insert fails -- a status moved with no record is the defect,
         * not the fix -- so that throw is caught here and the order FALLS THROUGH to the skip path
         * below. Degrading to the previous behaviour for one order is the correct failure mode;
         * losing the rest of the sweep is not.
         */
        try {
          const held = await holdForVerificationUnavailable(supabase, {
            orderId,
            restaurantId: orderRestaurantId,
            merchantOrderNo,
            orderTotal: Number(order.total),
            observationCount: priorSkipCounts.get(orderId) ?? 0,
          })
          if (held) result.heldVerificationUnavailableIds.push(orderId)
          // NOT pushed to skippedUncertainIds. A held order was not skipped -- it was taken out of
          // the loop, which is the whole distinction, and counting it as a skip would keep it in
          // the number the cron logs as "retrying next run".
          continue
        } catch (holdErr) {
          console.error(
            `[autoCancelStalePosOrders] could not hold order ${orderId} for verification-unavailable review; falling back to the skip path:`,
            holdErr,
          )
        }
      }

      // Finatic unreachable or errored -- no confident answer, but a future run may get one.
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

  return finalise(result)
}

/**
 * Every count is derived from its id list, in ONE place, and every `return result` goes through
 * here. The counts were previously assigned at the last return only, so the two early returns
 * above reported zero for fields whose id lists were non-empty -- harmless while the only such
 * field was populated after them, and a live wrong number the moment #153 added a field populated
 * BEFORE them (the release pass runs first).
 *
 * #353 added a THIRD early return (`rows.length === 0`, the run whose only stale candidates were
 * non-POS) and a field populated before it, so its count is derived here too rather than assigned
 * at the partition. One rule, one place, no exceptions -- the exception is what the bug was.
 */
function finalise(result: AutoCancelStalePosOrdersResult): AutoCancelStalePosOrdersResult {
  result.cancelledCount = result.cancelledIds.length
  result.correctedToPaidCount = result.correctedToPaidIds.length
  result.heldForAmountReviewCount = result.heldForAmountReviewIds.length
  result.skippedUncertainCount = result.skippedUncertainIds.length
  result.heldVerificationUnavailableCount = result.heldVerificationUnavailableIds.length
  result.releasedVerificationUnavailableCount = result.releasedVerificationUnavailableIds.length
  result.surfacedNeedsHumanCount = result.surfacedNeedsHumanIds.length
  return result
}
