/**
 * THE PER-ORDER MANUAL OVERRIDE — a human overruling the E04111 persistence rule.
 *
 * ================================================================================================
 * WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
 * ================================================================================================
 *
 * `e04111PersistenceAuthorisesCancel` refuses to cancel an order until the gateway has reported
 * E04111 for 72 hours, twice, at least 24 hours apart, reconfirmed at the moment of the write. That
 * rule is correct and it is not being weakened.
 *
 * But it leaves a real hole: Riviera's board carries eight held orders, N$1,176, most of them
 * minutes old. The rule refuses every one, correctly, and there is NO WAY TO ACT ON ANY OF THEM.
 * A safety rule with no escape hatch is a board that only ever grows, and staff learn to ignore it.
 *
 * So this is the hatch, and it is shaped to be one:
 *
 *   - PER ORDER. Not a blanket clear. Each press is a decision about one order and one amount.
 *   - AUDITED AS AN OVERRIDE, not as a rule firing. Someone reading the trail months later must be
 *     able to tell that a person overruled the system, who they were, and what the gateway said at
 *     that exact moment.
 *   - RE-QUERIED IMMEDIATELY BEFORE THE WRITE. Same guard as the clear-all: a decision made on a
 *     list gathered when the dashboard last polled is a decision made on stale data.
 *
 * ================================================================================================
 * AN OVERRIDE IS PERMISSION TO OVERRULE A TIMING RULE. IT IS NEVER PERMISSION TO CANCEL A PAID
 * ORDER.
 * ================================================================================================
 *
 * This is the one refusal that cannot be overridden by anybody, and it is why the gateway is
 * re-queried rather than trusted from the row: if the fresh answer is PAID, the order is NOT
 * cancelled, whatever the operator intended and whatever the board said a moment ago.
 *
 * The E04111 timing rule exists because a single "no record" is not terminal -- order #149 at
 * Mingle went `verification_uncertain` -> `completed` in 22 seconds on the same reference. That is
 * exactly the race an operator override drives straight into, because the operator presses the
 * button precisely when the order is fresh. So the re-query is not ceremony; it is the only thing
 * standing between a well-meant override and cancelling a charge that landed while the dialog was
 * open.
 *
 * An unrecognised status refuses too. `paid: false` collapses every value the gateway could return
 * into "not paid", so `statusRecognised` is checked first -- unknown never authorises a cancel.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  finaticErrorCode,
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '@/lib/payments/query-finatic-order-paid'
import { heldForReviewCause, neverAttemptedPayment } from '@/lib/orders/held-for-review'
import {
  OVERRIDE_CANCEL_AUDIT_REASON,
  OVERRIDE_CANCEL_NEVER_ATTEMPTED_AUDIT_REASON,
  OVERRIDE_CANCEL_REFUSAL_COPY,
  type OverrideCancelRefusal,
} from '@/lib/orders/override-cancel-copy'

/** The audit action. Distinct from the clear-all's, so the two are separable in a query. */
export const OVERRIDE_CANCEL_ACTION = 'order_held_operator_override_cancel'
export const OVERRIDE_CANCEL_REFUSED_ACTION = 'order_held_operator_override_refused'

export type OverrideCancelResult =
  | {
      ok: true
      orderId: string
      orderNumber: number | null
      total: number | null
      gatewayCode: string | null
      gatewayStatus: string | null
      ageHours: number | null
    }
  | {
      ok: false
      refusal: OverrideCancelRefusal
      message: string
      orderId: string
      gatewayCode: string | null
      gatewayStatus: string | null
    }

const ORDER_COLUMNS =
  'id, restaurant_id, order_number, status, payment_status, total, placed_at, ' +
  'paycloud_merchant_order_no, payment_reference, payment_voucher_no, payment_attempt_started_at'

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hoursSince(iso: unknown, nowMs: number): number | null {
  const t = new Date(String(iso ?? '')).getTime()
  if (!Number.isFinite(t)) return null
  return Math.round(((nowMs - t) / 3_600_000) * 10) / 10
}

export async function overrideCancelHeldOrder(
  supabase: SupabaseClient,
  params: { restaurantId: string; orderId: string; requestedBy: string },
): Promise<OverrideCancelResult> {
  const { restaurantId, orderId, requestedBy } = params
  const nowMs = Date.now()

  const refuse = async (
    refusal: OverrideCancelRefusal,
    extra: { gatewayCode?: string | null; gatewayStatus?: string | null; note?: string } = {},
  ): Promise<OverrideCancelResult> => {
    /**
     * EVERY REFUSAL IS AUDITED, not just the cancels. A refusal is the system declining to do
     * something a named person asked it to do, and "why did nothing happen when I pressed it" is
     * exactly the question that gets asked afterwards. An unaudited refusal makes the override
     * look broken rather than careful.
     */
    await supabase.from('audit_logs').insert({
      restaurant_id: restaurantId,
      entity_type: 'order',
      entity_id: orderId,
      action: OVERRIDE_CANCEL_REFUSED_ACTION,
      metadata: {
        source: 'held_for_review_operator_override',
        operatorOverride: true,
        requestedBy,
        refusal,
        gatewayCode: extra.gatewayCode ?? null,
        gatewayStatus: extra.gatewayStatus ?? null,
        askedAt: new Date(nowMs).toISOString(),
        note: extra.note ?? null,
        staffMessage: OVERRIDE_CANCEL_REFUSAL_COPY[refusal],
      },
    })

    return {
      ok: false,
      refusal,
      message: OVERRIDE_CANCEL_REFUSAL_COPY[refusal],
      orderId,
      gatewayCode: extra.gatewayCode ?? null,
      gatewayStatus: extra.gatewayStatus ?? null,
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) throw error
  const row = data as Record<string, unknown> | null
  if (!row) return refuse('order_not_found')

  // Re-asserted from the row we just read, not from what the client believed when it rendered.
  if (!heldForReviewCause(row as never, nowMs)) return refuse('order_not_held')

  /**
   * THE MARKER CHECK RUNS FIRST, BEFORE ANY PATH IS CHOSEN. An order carrying a reference or a
   * voucher from the card machine is evidence a card was presented, and it must never reach the
   * light path however empty its other fields are.
   */
  if (trimmed(row.payment_reference) || trimmed(row.payment_voucher_no)) {
    return refuse('payment_marker_present')
  }

  /**
   * ============================================================================================
   * THE LIGHT PATH -- no payment was ever started, so there is nothing to ask the gateway.
   * ============================================================================================
   *
   * A Finatic charge requires a merchant order number. With no reference AND no attempt
   * timestamp, none was ever created, so no charge was possible. Querying the gateway would be
   * asking about a reference that does not exist, and the answer could only ever be E04111 --
   * ceremony that tells nobody anything.
   *
   * THE GUARD IS `neverAttemptedPayment`, and it is deliberately conjunctive: EITHER a reference
   * OR an attempt timestamp sends the order down the heavy path with its gateway re-query and its
   * PAID refusal intact. This path is not a relaxation of that rule; it is a different case.
   */
  if (neverAttemptedPayment(row as never)) {
    const previous = trimmed(row.payment_status)
    const { data: lightUpdated, error: lightError } = await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: 'cancelled',
        cancelled_at: new Date(nowMs).toISOString(),
        cancellation_reason: 'operator_override_never_attempted',
      })
      .eq('id', orderId)
      .eq('restaurant_id', restaurantId)
      .eq('payment_status', previous)
      .select('id, order_number, total')
      .maybeSingle()

    if (lightError) throw lightError
    if (!lightUpdated?.id) return refuse('order_not_held', { note: 'payment_status changed under us' })

    await supabase.from('audit_logs').insert({
      restaurant_id: restaurantId,
      entity_type: 'order',
      entity_id: orderId,
      action: OVERRIDE_CANCEL_ACTION,
      metadata: {
        source: 'held_for_review_operator_override',
        operatorOverride: true,
        // Named so the two paths are separable in a query. A reader must never have to infer
        // which one ran from the absence of a gateway code.
        path: 'never_attempted',
        overrodeRule: null,
        requestedBy,
        cancelledAt: new Date(nowMs).toISOString(),
        gatewayQueried: false,
        gatewayCode: null,
        gatewayStatus: null,
        businessOrderNo: null,
        orderNumber: lightUpdated.order_number ?? null,
        orderTotal: lightUpdated.total ?? null,
        previousPaymentStatus: previous,
        attemptStartedAt: null,
        ageHours: hoursSince(row.placed_at, nowMs),
        reason: OVERRIDE_CANCEL_NEVER_ATTEMPTED_AUDIT_REASON,
      },
    })

    return {
      ok: true,
      orderId,
      orderNumber: (lightUpdated.order_number as number) ?? null,
      total: (lightUpdated.total as number) ?? null,
      gatewayCode: null,
      gatewayStatus: null,
      ageHours: hoursSince(row.placed_at, nowMs),
    }
  }

  /**
   * Heavy path from here. Reachable only when a reference or an attempt timestamp exists, so an
   * order with an attempt but no reference still refuses -- there is genuinely nothing to
   * re-check, and something was started.
   */
  const merchantOrderNo = trimmed(row.paycloud_merchant_order_no)
  if (!merchantOrderNo) return refuse('no_gateway_reference')

  const { data: venue } = await supabase
    .from('restaurants')
    .select('finatic_merchant_no, finatic_store_no')
    .eq('id', restaurantId)
    .maybeSingle()

  const merchantNo = trimmed(venue?.finatic_merchant_no)
  const storeNo = trimmed(venue?.finatic_store_no)
  if (!merchantNo || !storeNo) return refuse('gateway_unreachable', { note: 'no_credentials' })

  // ---- THE RE-QUERY. Everything above is cheap; this is the guard. --------------------------
  let gatewayCode: string | null = null
  let gatewayStatus: string | null = null

  try {
    const answer = await queryFinaticOrderPaid({ merchantOrderNo, merchantNo, storeNo })
    gatewayStatus = answer.status ?? null

    // PAID REFUSES, ALWAYS. See the header: this is the refusal no override can pass.
    if (answer.paid) {
      return refuse('gateway_reports_paid', { gatewayStatus, gatewayCode: null })
    }

    // Unknown never authorises a cancel. `paid: false` alone cannot tell "it failed" from
    // "the gateway said something we have never seen".
    if (!answer.statusRecognised) {
      return refuse('gateway_status_unrecognised', { gatewayStatus })
    }
  } catch (err) {
    // E04111 -- "no record of this reference" -- is the expected answer here and is what the
    // override exists to act on. Any other throw is an unreachable gateway and refuses.
    if (!isFinaticMerchantOrderInvalidError(err)) {
      return refuse('gateway_unreachable', { gatewayCode: finaticErrorCode(err) })
    }
    gatewayCode = finaticErrorCode(err) ?? 'E04111'
  }

  // ---- the write ---------------------------------------------------------------------------
  /**
   * CONDITIONAL ON THE PAYMENT STATUS WE READ. Two presses, or a terminal callback landing while
   * the dialog was open, produce a second writer that matches zero rows rather than cancelling an
   * order that has since been paid. Same idempotency shape as the clear-all, and for the same
   * reason: there is no shared in-memory lock across worker isolates, so the guarantee has to be
   * in the UPDATE.
   */
  const previousPaymentStatus = trimmed(row.payment_status)
  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancelled_at: new Date(nowMs).toISOString(),
      cancellation_reason: 'operator_override_e04111',
    })
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .eq('payment_status', previousPaymentStatus)
    .select('id, order_number, total')
    .maybeSingle()

  if (updateError) throw updateError
  if (!updated?.id) return refuse('order_not_held', { note: 'payment_status changed under us' })

  const ageHours = hoursSince(row.payment_attempt_started_at ?? row.placed_at, nowMs)

  /**
   * THE AUDIT ROW. Everything the owner asked to be recorded, and the numbers the decision was
   * taken on -- a verdict with no numbers behind it is unauditable.
   */
  await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    entity_type: 'order',
    entity_id: orderId,
    action: OVERRIDE_CANCEL_ACTION,
    metadata: {
      source: 'held_for_review_operator_override',
      // The flag that separates this from the rule firing. A reader must never have to infer it.
      operatorOverride: true,
      path: 'gateway_requeried',
      gatewayQueried: true,
      overrodeRule: 'e04111_persistence_2026_08_27',
      requestedBy,
      cancelledAt: new Date(nowMs).toISOString(),
      gatewayCode,
      gatewayStatus,
      gatewayAskedAt: new Date(nowMs).toISOString(),
      businessOrderNo: merchantOrderNo,
      orderNumber: updated.order_number ?? null,
      orderTotal: updated.total ?? null,
      previousPaymentStatus,
      attemptStartedAt: row.payment_attempt_started_at ?? null,
      ageHours,
      reason: OVERRIDE_CANCEL_AUDIT_REASON,
    },
  })

  return {
    ok: true,
    orderId,
    orderNumber: (updated.order_number as number) ?? null,
    total: (updated.total as number) ?? null,
    gatewayCode,
    gatewayStatus,
    ageHours,
  }
}
