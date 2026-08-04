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
 * True when this order was cancelled on E04111 evidence, by EITHER rule.
 *
 * Both are cancellations made because Finatic said it had no record of the reference --
 * and E04111 is time-dependent, so both can be wrong in exactly the same way. Which rule
 * did the cancelling is irrelevant to whether a later payment must be recoverable.
 */
export function isCancelledOnE04111Evidence(
  row: RecoverableOrderRow | null | undefined,
): boolean {
  if (!row) return false
  if (String(row.payment_status ?? '').trim().toLowerCase() !== 'cancelled') return false
  const reason = String(row.cancellation_reason ?? '').trim().toLowerCase()
  return (
    reason.startsWith(AUTO_CANCELLED_E04111_REASON_PREFIX) || reason === NO_PAYMENT_ATTEMPT_REASON
  )
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
