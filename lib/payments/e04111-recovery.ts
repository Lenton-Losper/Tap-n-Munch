import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { CLAIMABLE_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * Reason prefix written by the E04111 persistent-stranding auto-cancel rule (PR 2).
 */
export const AUTO_CANCELLED_E04111_REASON_PREFIX = 'auto_cancelled_e04111'

/**
 * Reason written by the marker-gated E04111 branch that shipped to staging ahead of PR 2
 * (`cancelByIds(..., 'no_payment_attempt_made')`). PR 2 removes that branch, but orders it
 * already cancelled still exist and still need the recovery path.
 */
export const NO_PAYMENT_ATTEMPT_REASON = 'no_payment_attempt_made'

/** Audit action emitted when a payment lands for an order we already auto-cancelled. */
export const RECOVERED_AFTER_AUTO_CANCEL_ACTION = 'payment.recovered_after_auto_cancel'

export type RecoverableOrderRow = {
  payment_status?: unknown
  cancellation_reason?: unknown
}

/**
 * Cancellation reasons that represent a DELIBERATE decision that the order is dead, and which a
 * webhook must therefore not revive.
 *
 * This is the list that carries the risk, so it is the list that is enumerated. Everything else is
 * recoverable -- see isCancelledOnE04111Evidence.
 *
 * Matched as prefixes so a reason that appends detail (`staff_cancelled: wrong table`) still
 * matches. Measured against the live vocabulary on 2026-08-22: auto_timeout (137),
 * payment_declined (35), terminal_cancelled_by_user_pre_gateway (33), terminal_cancelled (1),
 * terminal_callback_incomplete (1).
 */
export const NON_RECOVERABLE_CANCELLATION_REASON_PREFIXES = [
  'auto_timeout',
  'hosted_timeout',
  'staff_',
  'terminal_cancelled',
  'terminal_callback_incomplete',
  'payment_declined',
] as const

/**
 * True when a later, proven payment must be allowed to revive this cancelled order.
 *
 * INVERTED 2026-08-22, and the inversion IS the fix. This used to be an ALLOWLIST of two reason
 * strings -- `auto_cancelled_e04111*` and `no_payment_attempt_made` -- while the docblock above it
 * said "which rule did the cancelling is irrelevant to whether a later payment must be
 * recoverable". The code did not match that intent: it enumerated rules, so every rule nobody
 * thought to add was silently unrecoverable.
 *
 * WHAT THAT COST, measured on production 2026-08-22: 27 cancelled orders were unrecoverable that
 * should not have been. Nine carried `operator_ruling_finatic_confirmed_unpaid_20260821`, and
 * about eighteen carried long manual-Finatic-portal confirmations -- every one of them cancelled on
 * gateway evidence of non-payment, exactly the class this file exists to protect. One of those
 * reasons ends with the sentence "If a charge is later found, this order must be treated as
 * recoverable." The code could not honour it.
 *
 * SO THE AXIS IS INVERTED. Enumerate what must NOT be revived -- the deliberate-death reasons the
 * original docblock already named -- and let everything else through. Adding one more string to an
 * allowlist would have fixed nine orders and left the same trap set for the tenth rule.
 *
 * IT FAILS TOWARD RECOVERY, deliberately. A new cancel reason nobody classifies becomes
 * recoverable rather than silently unrecoverable. That is the right direction: the recovery only
 * ever fires on a PROVEN payment, so the cost of a wrong revive is an order restored for money
 * that was genuinely taken, while the cost of a wrong refusal is a real payment discarded and a
 * customer charged for nothing.
 *
 * The name is kept for its callers and its history, though it is now broader than E04111.
 */
export function isCancelledOnE04111Evidence(
  row: RecoverableOrderRow | null | undefined,
): boolean {
  if (!row) return false
  if (String(row.payment_status ?? '').trim().toLowerCase() !== 'cancelled') return false

  /**
   * NULL IS NOT AN UNCLASSIFIED REASON. IT IS THE ABSENCE OF ONE. Ruled 2026-08-24.
   *
   * The inversion above fails toward recovery for a reason STRING nobody has classified yet --
   * a deliberate choice, because the recovery only fires on a proven payment. A NULL reason is
   * a different thing: no rule recorded why this order died, so there is nothing to weigh.
   *
   * Without this branch the answer came out `recoverable` ANYWAY, purely because
   * String(null ?? '') is '' and ''.startsWith(anything) is false, so the denylist matched
   * nothing. That is an accident of the expression, not a decision, and it is stated here
   * explicitly so nobody re-derives the opposite conclusion from the same accident.
   *
   * THIS BRANCH DOES NOT TOUCH THE 2026-08-21 OPERATOR RULINGS. Orders carrying
   * `operator_ruling_finatic_confirmed_unpaid_20260821` remain RECOVERABLE, which is the whole
   * point of the 2026-08-22 inversion described above -- that string matches no enumerated
   * prefix, and one of those very reasons ends "If a charge is later found, this order must be
   * treated as recoverable." Verified by evaluating the predicate, not by reading the list.
   *
   * Only a row with NO reason recorded is refused here.
   */
  if (row.cancellation_reason == null) return false

  const reason = String(row.cancellation_reason).trim().toLowerCase()
  // An empty-or-whitespace reason is the same absence wearing a string, and is refused for the
  // same reason -- otherwise the accident above returns through the back door.
  if (reason === '') return false
  return !NON_RECOVERABLE_CANCELLATION_REASON_PREFIXES.some((p) => reason.startsWith(p))
}

/**
 * payment_status values markOrderPaidConfirmed may transition an order from.
 *
 * Widened with 'cancelled' ONLY for orders cancelled on E04111 evidence. Without this, a
 * cancelled order sits outside CLAIMABLE_PAYMENT_STATUSES (['unpaid','pending']) and every
 * recovery path silently no-ops: the claim UPDATE matches zero rows, returns claimed:false,
 * and a real Finatic-verified payment is discarded.
 *
 * Deliberately NOT widened for 'auto_timeout', 'hosted_timeout', or staff-initiated
 * cancellations. Those represent a human or a different rule deciding the order is dead;
 * reviving them from a webhook would be a separate and much riskier change.
 */
export function claimableStatusesForRecovery(
  row: RecoverableOrderRow | null | undefined,
): readonly string[] {
  return isCancelledOnE04111Evidence(row)
    ? [...CLAIMABLE_PAYMENT_STATUSES, 'cancelled']
    : CLAIMABLE_PAYMENT_STATUSES
}

/**
 * Records that a payment arrived for an order the E04111 rule had already cancelled.
 *
 * This is never routine: it means an auto-cancel fired on an order that turned out to have
 * a real payment. Written at error severity so computePlatformAlerts surfaces it as a
 * critical alert rather than leaving it buried in audit history. Never throws -- a failed
 * audit insert must not roll back a recovery that already committed.
 */
export async function recordRecoveredAfterAutoCancel(
  supabase: Supabase,
  params: {
    restaurantId: string
    orderId: string
    reference: string
    /** Caller tag, e.g. 'paycloud_webhook_fallback_finatic_verified'. */
    source: string
    /** cancellation_reason the order carried before recovery. */
    previousCancellationReason: string | null
    previousCancelledAt?: string | null
    amount?: number | null
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: params.restaurantId,
      action: RECOVERED_AFTER_AUTO_CANCEL_ACTION,
      entity_type: 'order',
      entity_id: params.orderId,
      metadata: {
        severity: 'error',
        reference: params.reference,
        businessOrderNo: params.reference,
        source: params.source,
        previousCancellationReason: params.previousCancellationReason,
        previousCancelledAt: params.previousCancelledAt ?? null,
        amount: params.amount ?? null,
        requiresReconciliation: true,
        note:
          'Payment confirmed for an order that had already been auto-cancelled on E04111 ' +
          'evidence. The order has been restored to paid/completed and its cancellation ' +
          'fields cleared, but the goods were likely never produced -- needs human reconciliation.',
        ...params.metadata,
      },
    })
    if (error) {
      console.error(
        `[recordRecoveredAfterAutoCancel] audit insert failed for order ${params.orderId}:`,
        error,
      )
    }
  } catch (err) {
    console.error(
      `[recordRecoveredAfterAutoCancel] audit insert threw for order ${params.orderId}:`,
      err,
    )
  }
}
