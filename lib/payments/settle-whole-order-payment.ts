/**
 * THE ONE WRITER FOR A GATEWAY-CONFIRMED WHOLE-ORDER PAYMENT.
 *
 * ==================================================================================================
 * WHAT IT REPLACES, AND WHY IT IS A FUNCTION RATHER THAN A FIX
 * ==================================================================================================
 *
 * Three places independently turned "the gateway says this was paid" into database writes:
 *
 *   app/api/webhooks/paycloud/route.ts      markOrdersPaidConfirmedByIds (both signature legs)
 *   .../orders/[orderId]/verify-payment     settlementSetFor + markOrderPaidConfirmed(orderId)
 *   app/api/payments/reconcile/route.ts     its own expectation + markOrderPaidConfirmed
 *
 * Each computed its own expectation and each applied its own writes, and two of the three verified
 * a WIDER set than they wrote:
 *
 *   webhook          verified `settlementRows` (both Riviera orders, N$720)
 *                    wrote    `orderRows`      (the lead order alone, N$500)
 *   verify-payment   verified settlementSetFor(order).orders
 *                    wrote    the single `orderId` from the URL
 *
 * Production, 2026-09-18: Riviera settlement 4158ff51 charged N$720 across orders #154 and #155,
 * marked #155 paid, left #154 unpaid, and stamped `gatewayAmount: 720` on the N$500 order.
 *
 * So the verification and the application are no longer two pieces of code that happen to agree.
 * `resolveSettlementTarget` returns ONE `SettlementTarget`; this function checks the gateway amount
 * against it and hands THAT SAME OBJECT to `settle_order_payment`, which locks the rows, re-derives
 * the expectation from them and writes them, all in one transaction.
 *
 * ==================================================================================================
 * WHAT IT DOES NOT DO
 * ==================================================================================================
 *
 * IT DOES NOT SETTLE ALLOCATIONS. A part-order charge names items, not orders;
 * `settleAllocationsForIntent` is that path and the two must never be interchangeable -- reaching
 * a whole-order writer with an allocation-scope intent is the defect that closed order #45.
 * IT DOES NOT CANCEL ANYTHING on a refusal. The gateway has just said the customer was charged.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  gatewayAmountAgrees,
  resolveSettlementTarget,
  settlementAuditFigures,
  type SettlementTarget,
} from '@/lib/payments/settlement-target'
import type { PaymentIntent } from '@/lib/payments/payment-intents'
import {
  isCancelledOnE04111Evidence,
  recordRecoveredAfterAutoCancel,
} from '@/lib/payments/e04111-recovery'
import {
  recordPaymentAmountMismatch,
  type AmountMismatchSource,
} from '@/lib/payments/record-amount-mismatch'
import { safeIssueReceiptsForOrders } from '@/lib/receipts/safeIssueReceipt'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type SettleWholeOrderParams = {
  /**
   * The venue, when the caller knows it. A terminal-authenticated route always does; the webhook
   * resolves a bare gateway reference and does not, so it passes null and the venue is derived
   * from the orders themselves (a set spanning two venues is refused).
   */
  restaurantId: string | null
  /** The ids a gateway reference resolved to — typically the lead order alone. */
  leadOrderIds: string[]
  /** The intent the reference resolved to, when the charge was launched through one. */
  intent?: PaymentIntent | null
  /** The gateway reference (businessOrderNo). */
  merchantOrderNo: string
  /** The gateway's own transaction id, when it gave one. */
  transactionId?: string | null
  /**
   * THE AUTHORITATIVE COLLECTED AMOUNT, in major units, as the gateway reported it.
   * `null` means the gateway gave none — which is UNVERIFIED, not agreeing.
   */
  gatewayAmount: number | null
  /**
   * THE CHANNEL THE MONEY CAME THROUGH (F3).
   *
   * Required, and there is deliberately no default. A gateway confirmation IS the evidence of the
   * channel, so a caller that cannot name it has not established one. The pattern this replaces --
   * `(row.payment_method as string) || 'card'` at webhook route line 314 -- recorded a real card
   * payment as `cash` on any order that had previously been moved to `cash_pending`.
   */
  paymentMethod: 'card' | 'cash' | 'paytoday'
  /** Free-text caller tag for the audit trail, e.g. 'paycloud_webhook_fallback_finatic_verified'. */
  source: string
  /**
   * WHICH GATEWAY LEG THIS IS, from `recordPaymentAmountMismatch`'s CLOSED set.
   *
   * Deliberately a second field rather than reusing `source`. That enum is narrow on purpose --
   * its docblock enumerates exactly the four places a mismatch can occur AFTER a card has been
   * charged, and widening it to `string` to save a parameter would quietly let any caller invent a
   * new category that no reconciliation query knows to look for.
   */
  mismatchSource: AmountMismatchSource
  terminalId?: string | null
  appVersion?: string | null
  /** Extra audit metadata merged into the refusal rows. */
  extraAuditMetadata?: Record<string, unknown>
}

export type SettleWholeOrderResult =
  | {
      ok: true
      /** True when this call performed the writes; false when it found them already done. */
      applied: boolean
      reason: 'settled' | 'already_consumed'
      claimedOrderIds: string[]
      intendedOrderIds: string[]
      expectedAmount: number
      target: SettlementTarget | null
    }
  | {
      ok: false
      /**
       * `amount_mismatch` is recorded on every affected order and is NOT retryable — the gateway
       * will report the same figure next time. Everything else is transient and the caller should
       * ask the gateway to retry.
       */
      reason:
        | 'amount_mismatch'
        | 'target_unreadable'
        | 'target_changed'
        | 'illegal_transition'
        | 'intent_conflict'
        | 'rpc_failed'
      detail?: unknown
      target: SettlementTarget | null
    }

/**
 * Apply a gateway-confirmed whole-order payment, atomically, to exactly the intended orders.
 */
export async function settleWholeOrderPayment(
  supabase: Supabase,
  params: SettleWholeOrderParams,
): Promise<SettleWholeOrderResult> {
  const resolved = await resolveSettlementTarget(supabase, {
    restaurantId: params.restaurantId,
    leadOrderIds: params.leadOrderIds,
    intent: params.intent ?? null,
  })

  if (!resolved.ok) {
    /**
     * FAILS CLOSED. Not being able to read the whole settlement is not permission to settle part
     * of it — that is the Riviera outcome reached deliberately. Nothing is written and the caller
     * asks the gateway to retry.
     */
    console.error(`[settleWholeOrderPayment:${params.source}] target unreadable`, {
      reason: resolved.reason,
      merchantOrderNo: params.merchantOrderNo,
    })
    return { ok: false, reason: 'target_unreadable', detail: resolved.reason, target: null }
  }

  const target = resolved.target
  /**
   * FROM THE TARGET, not from the argument. When the caller passed null this is the venue derived
   * from the rows; when it passed one, resolveSettlementTarget has already proved they agree.
   * Every write below is scoped by this single value.
   */
  const restaurantId = target.restaurantId

  // ---- the amount gate, against the set that is about to be written ------------------------
  if (!gatewayAmountAgrees(target, params.gatewayAmount)) {
    const reason =
      params.gatewayAmount == null
        ? `The gateway confirmed ${params.merchantOrderNo} but gave no amount — the amount was ` +
          'never verified, so the settlement is not applied.'
        : `The gateway confirmed ${params.gatewayAmount} for ${params.merchantOrderNo}, but the ` +
          `${target.orders.length} covered order(s) expect ${target.expectedAmount} — not ` +
          'applying, and not cancelling an order the gateway says was charged.'
    console.error(`[settleWholeOrderPayment:${params.source}] ${reason}`)

    const figures = settlementAuditFigures(target, params.gatewayAmount)

    for (const orderId of target.orderIds) {
      /**
       * NOT WRITTEN WHEN THE AMOUNT IS ABSENT. A mismatch row carrying `receivedAmount: null`
       * would assert a comparison that never happened — null is "never checked", not "checked and
       * disagreed", and keeping those distinguishable is the whole of the #190 split.
       */
      if (params.gatewayAmount != null) {
        await recordPaymentAmountMismatch(supabase, {
          restaurantId,
          orderId,
          expectedAmount: target.expectedAmount,
          receivedAmount: params.gatewayAmount,
          source: params.mismatchSource,
          businessOrderNo: params.merchantOrderNo,
          reference: params.merchantOrderNo,
        })
      }

      const { error } = await supabase.from('audit_logs').insert({
        restaurant_id: restaurantId,
        action: 'payment.verification_uncertain',
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          reason,
          amountVerified: false,
          businessOrderNo: params.merchantOrderNo,
          source: params.source,
          outcome: 'left_pending_finatic_uncertain',
          /**
           * THE EXISTING VOCABULARY IS KEPT, DELIBERATELY.
           *
           * `gatewayAmount` / `expectedAmount` are the names every other writer of
           * `payment.verification_uncertain` already uses -- the auto-cancel cron
           * (auto-cancel-stale-pos-orders.ts:261), reconcile-orphan-payments.ts:165, and this
           * route's predecessor -- and the E04111 resolution procedure reads them by hand.
           * Renaming them would fragment a shared vocabulary across a table nobody can migrate,
           * for no gain: on THIS path both figures genuinely are settlement-level, because the
           * comparison that failed was settlement-level.
           *
           * What F15 forbids is a PER-ORDER figure being presented as the gateway's, which is the
           * `gatewayAmount: 720 on a N$500 order` defect. The settlement-scoped names below say
           * how many orders the figure covers, so a reader can tell the two apart -- which was
           * impossible before.
           */
          gatewayAmount: params.gatewayAmount,
          expectedAmount: target.expectedAmount,
          ...figures,
          ...params.extraAuditMetadata,
        },
      })
      if (error) {
        console.error(
          `[settleWholeOrderPayment:${params.source}] verification_uncertain audit failed`,
          error,
        )
      }
    }

    return { ok: false, reason: 'amount_mismatch', target }
  }

  /**
   * WHICH CANCELLED ORDERS MAY RECOVER.
   *
   * Decided HERE and not in SQL: the rule weighs `cancellation_reason` against an enumerated
   * denylist and a 2026-08-21 operator ruling, and re-expressing that in plpgsql would be a second
   * copy of a rule that has already been got wrong once. The function refuses `cancelled -> paid`
   * for any id not in this list.
   */
  const allowCancelledRecovery = target.orders
    .filter((row) => isCancelledOnE04111Evidence(row as Parameters<typeof isCancelledOnE04111Evidence>[0]))
    .map((row) => String(row.id))

  const previousCancellation = new Map(
    target.orders.map((row) => [
      String(row.id),
      {
        reason: row.cancellation_reason ? String(row.cancellation_reason) : null,
        at: row.cancelled_at ? String(row.cancelled_at) : null,
      },
    ]),
  )

  const intent = params.intent ?? null
  const tipCents = intent && intent.scope === 'orders' ? intent.tipCents : target.tipCents
  const tipStaffUserId =
    intent && intent.scope === 'orders' && intent.tipStaffUserId ? intent.tipStaffUserId : null

  const { data, error } = await supabase.rpc('settle_order_payment', {
    p_restaurant_id: restaurantId,
    // THE TARGET'S OWN IDS. Not a list built anywhere else in this function.
    p_order_ids: [...target.orderIds],
    p_expected_amount_cents: target.expectedAmountCents,
    p_gateway_amount_cents: Math.round(Number(params.gatewayAmount) * 100),
    p_gateway_transaction_id: params.transactionId ?? null,
    p_payment_reference: params.merchantOrderNo,
    p_payment_method: params.paymentMethod,
    p_merchant_order_no: params.merchantOrderNo,
    p_intent_id: intent && intent.scope === 'orders' ? intent.id : null,
    p_source: params.source,
    p_terminal_id: params.terminalId ?? null,
    p_tip_cents: tipCents,
    p_tip_staff_user_id: tipStaffUserId,
    p_allow_cancelled_recovery: allowCancelledRecovery,
    p_app_version: params.appVersion ?? null,
  })

  if (error) {
    /**
     * THE TRANSACTION ROLLED BACK, so nothing is half-applied. The gateway is asked to retry
     * rather than ACKed: ACKing a payment we failed to record is how a real charge is discarded
     * with a success log.
     */
    console.error(`[settleWholeOrderPayment:${params.source}] RPC failed`, {
      merchantOrderNo: params.merchantOrderNo,
      orderIds: target.orderIds,
      error: error.message,
    })
    return { ok: false, reason: 'rpc_failed', detail: error.message, target }
  }

  const result = (data ?? {}) as {
    ok?: boolean
    reason?: string
    applied?: boolean
    claimed_order_ids?: string[]
    intended_order_ids?: string[]
    expected_amount_cents?: number
  }

  if (result.ok !== true) {
    console.error(`[settleWholeOrderPayment:${params.source}] settlement refused`, {
      merchantOrderNo: params.merchantOrderNo,
      result,
    })
    const reason =
      result.reason === 'target_changed_since_preparation'
        ? 'target_changed'
        : result.reason === 'illegal_transition'
          ? 'illegal_transition'
          : result.reason === 'amount_mismatch'
            ? 'amount_mismatch'
            : result.reason === 'orders_missing'
              ? 'target_unreadable'
              : 'intent_conflict'
    return { ok: false, reason, detail: result, target }
  }

  const claimed = (result.claimed_order_ids ?? []).map(String)

  /**
   * AFTER THE TRANSACTION, never inside it.
   *
   * Receipts and the recovery audit are best-effort follow-ups: the money is recorded and the
   * orders are paid whatever happens here, and letting either failure propagate would report a
   * completed settlement as an error and invite a retry against orders already claimed.
   */
  if (claimed.length > 0) {
    await safeIssueReceiptsForOrders(claimed, params.source)
  }

  for (const orderId of allowCancelledRecovery) {
    if (!claimed.includes(orderId)) continue
    const prev = previousCancellation.get(orderId)
    await recordRecoveredAfterAutoCancel(supabase, {
      restaurantId,
      orderId,
      reference: params.merchantOrderNo,
      source: params.source,
      previousCancellationReason: prev?.reason ?? null,
      previousCancelledAt: prev?.at ?? null,
      amount: target.expectedAmount,
      metadata: params.extraAuditMetadata,
    })
  }

  return {
    ok: true,
    applied: result.applied === true,
    reason: result.reason === 'already_consumed' ? 'already_consumed' : 'settled',
    claimedOrderIds: claimed,
    intendedOrderIds: (result.intended_order_ids ?? [...target.orderIds]).map(String),
    expectedAmount: target.expectedAmount,
    target,
  }
}
