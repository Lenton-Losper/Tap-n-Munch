import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { CLAIMABLE_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  queryFinaticOrderPaid,
  type FinaticOrderPaidResult,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { stagingFinaticQueryStub } from '@/lib/payments/staging-finatic-stub'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type HandleTerminalPaymentFailedParams = {
  orderId: string
  restaurantId: string
  /** Order total (major units) — used when Finatic omits amount. */
  orderTotal: number
  /** From prepare-payment; empty/null means no Finatic attempt was initiated. */
  paycloudMerchantOrderNo: string | null | undefined
  terminalId?: string | null
  /** Terminal-supplied failure reference (e.g. FT-FAIL-…). */
  reference?: string
  amount?: number
  paymentMethod?: string
  /**
   * Reason written on cancel. Defaults to payment_declined (payment callback).
   * Status-route cancels pass terminal_cancelled (or a caller-supplied reason).
   */
  cancellationReason?: string
  /** audit_logs.action on cancel. Defaults to payment.failed. */
  auditAction?: string
  /** markOrderPaidConfirmed source when Finatic confirms paid. */
  correctionSource?: string
  /** Extra text for the correction audit metadata. */
  correctionReason?: string
}

export type HandleTerminalPaymentFailedResult =
  | {
      outcome: 'cancelled'
      cancellationReason: string
      cancelledAt: string
    }
  | {
      outcome: 'corrected_to_paid'
      claimed: boolean
      tabId: string | null
    }
  | {
      outcome: 'left_pending_finatic_uncertain'
      reason: string
    }
  | {
      outcome: 'cancel_conflict'
    }

export type HandleTerminalPaymentFailedOptions = {
  /** Test-only seam: override the Finatic query call. Defaults to the real implementation. */
  queryFinaticOrderPaidFn?: typeof queryFinaticOrderPaid
  /**
   * Staging-only: request body `__stagingFinaticStub` ('paid' | 'not_paid' | 'unreachable').
   * Ignored unless ENVIRONMENT=staging (wrangler staging vars).
   */
  stagingFinaticStub?: unknown
}

/**
 * Shared Finatic-before-cancel for terminal payment-failed and status=cancelled
 * when a charge may already have been initiated (paycloud_merchant_order_no set).
 *
 *  - No paycloud_merchant_order_no → cancel immediately (nothing to verify).
 *  - Finatic confirms paid → correct to paid via markOrderPaidConfirmed (false-failure).
 *  - Finatic confirms not paid → cancel with the caller-supplied reason.
 *  - Finatic unreachable/errors/missing credentials → leave payment_status pending
 *    and write payment.verification_uncertain audit (cron may still resolve later).
 */
export async function handleTerminalPaymentFailed(
  supabase: Supabase,
  params: HandleTerminalPaymentFailedParams,
  options?: HandleTerminalPaymentFailedOptions,
): Promise<HandleTerminalPaymentFailedResult> {
  const cancellationReason = (params.cancellationReason || 'payment_declined').trim() || 'payment_declined'
  const auditAction = params.auditAction || 'payment.failed'
  const correctionSource =
    params.correctionSource || 'terminal_callback_false_failure_finatic_verified'
  const correctionReason =
    params.correctionReason ||
    'Terminal reported failure/cancel, but Finatic order.query confirmed a successful charge — corrected to paid instead of cancelling (false-failure guard).'

  const stubFn = stagingFinaticQueryStub(options?.stagingFinaticStub)
  const queryFn = options?.queryFinaticOrderPaidFn ?? stubFn ?? queryFinaticOrderPaid
  const merchantOrderNo = String(params.paycloudMerchantOrderNo || '').trim()
  const paymentMethod = params.paymentMethod || 'card'
  const terminalId = params.terminalId ?? null

  if (merchantOrderNo) {
    try {
      const usingInjectedQuery = Boolean(options?.queryFinaticOrderPaidFn || stubFn)
      let merchantNo = 'STAGING_STUB'
      let storeNo = 'STAGING_STUB'
      if (!usingInjectedQuery) {
        const creds = await getRestaurantFinaticCredentials(params.restaurantId)
        merchantNo = creds.merchantNo
        storeNo = creds.storeNo
      } else {
        // Best-effort real creds for stubs/seams; placeholders if the probe restaurant
        // has none (common on throwaway staging fixtures).
        try {
          const creds = await getRestaurantFinaticCredentials(params.restaurantId)
          merchantNo = creds.merchantNo
          storeNo = creds.storeNo
        } catch {
          // keep placeholders
        }
      }

      const finatic: FinaticOrderPaidResult = await queryFn({
        merchantOrderNo,
        merchantNo,
        storeNo,
      })

      if (finatic.paid) {
        const claim = await markOrderPaidConfirmed(supabase, {
          orderId: params.orderId,
          restaurantId: params.restaurantId,
          reference: merchantOrderNo,
          voucherNo: finatic.transactionId || merchantOrderNo,
          amount: finatic.amount ?? params.orderTotal,
          paymentMethod,
          terminalId,
          source: correctionSource,
          extraAuditMetadata: {
            correctionReason,
            terminalReportedReference: params.reference || null,
            terminalReportedAmount: params.amount ?? null,
            requestedCancellationReason: cancellationReason,
            finaticStatus: finatic.status,
            finaticTransactionId: finatic.transactionId,
            finaticAmount: finatic.amount,
          },
          fromPaymentStatuses: [...CLAIMABLE_PAYMENT_STATUSES],
        })

        return {
          outcome: 'corrected_to_paid',
          claimed: claim.claimed,
          tabId: claim.claimed ? claim.tabId : null,
        }
      }
      // Finatic explicitly not paid — fall through to cancel.
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[handleTerminalPaymentFailed] Finatic check failed for order ${params.orderId} — leaving pending:`,
        reason,
      )

      // Visibility only — order stays pending (same as before). Without this audit the
      // uncertain path looks identical to "terminal never reported failure."
      const { error: uncertainAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: params.restaurantId,
        action: 'payment.verification_uncertain',
        entity_type: 'order',
        entity_id: params.orderId,
        metadata: {
          reason,
          businessOrderNo: merchantOrderNo,
          reference: params.reference || null,
          amount: params.amount ?? null,
          terminalId,
          requestedCancellationReason: cancellationReason,
          outcome: 'left_pending_finatic_uncertain',
        },
      })
      if (uncertainAuditError) {
        console.error(
          '[handleTerminalPaymentFailed] payment.verification_uncertain audit failed:',
          uncertainAuditError,
        )
      }

      return { outcome: 'left_pending_finatic_uncertain', reason }
    }
  }

  const cancelledAt = new Date().toISOString()
  const { data: cancelled, error: cancelError } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancellation_reason: cancellationReason,
      cancelled_at: cancelledAt,
    })
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .in('payment_status', [...CLAIMABLE_PAYMENT_STATUSES])
    .select('id, status, payment_status, cancellation_reason, cancelled_at')
    .maybeSingle()

  if (cancelError) throw cancelError

  if (!cancelled) {
    return { outcome: 'cancel_conflict' }
  }

  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: params.restaurantId,
    action: auditAction,
    entity_type: 'order',
    entity_id: params.orderId,
    metadata: {
      reference: params.reference || null,
      amount: params.amount ?? null,
      terminalId,
      cancellation_reason: cancellationReason,
      finaticVerifiedBeforeCancel: Boolean(merchantOrderNo),
    },
  })
  if (auditError) {
    console.error('[handleTerminalPaymentFailed] audit log failed:', auditError)
  }

  return {
    outcome: 'cancelled',
    cancellationReason,
    cancelledAt,
  }
}
