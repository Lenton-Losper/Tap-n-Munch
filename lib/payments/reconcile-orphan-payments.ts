import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import {
  claimableStatusesForRecovery,
  isAutoCancelledE04111,
  recordRecoveredAfterAutoCancel,
} from '@/lib/payments/e04111-recovery'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type ReconcileOrphanPaymentsResult = {
  markedPaid: number
  markedPaidIds: string[]
  receiptsIssued: number
  /** Orders restored after the E04111 auto-cancel rule had cancelled them. */
  recoveredAfterAutoCancel: number
  recoveredAfterAutoCancelIds: string[]
}

/**
 * Recovery for race / legacy cases:
 * 1) Sale payment_events whose order_ids are still unpaid → mark paid + backfill merchant no.
 * 2) Paid orders missing a SALE_RECEIPT → safe-issue.
 *
 * Orders auto-cancelled by the E04111 rule go through markOrderPaidConfirmed rather than
 * the bulk update below. The bulk update sets payment_status/status but leaves cancelled_at
 * and cancellation_reason in place, producing a self-contradictory completed+paid+cancelled
 * row (the class scripts/check-paid-cancelled-contradictions-20260730.ts hunts for) and
 * telling nobody that an auto-cancel turned out to be wrong.
 *
 * Idempotent; safe to run on a schedule.
 */
export async function reconcileOrphanPayments(
  supabase: Supabase,
  options: { lookbackHours?: number; limit?: number } = {},
): Promise<ReconcileOrphanPaymentsResult> {
  const lookbackHours = options.lookbackHours ?? 48
  const limit = options.limit ?? 100
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()

  const markedPaidIds: string[] = []
  const recoveredAfterAutoCancelIds: string[] = []

  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('id, business_order_no, order_ids, created_at')
    .eq('event_type', 'sale')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (eventsError) {
    throw new Error(`reconcileOrphanPayments: payment_events: ${eventsError.message}`)
  }

  for (const event of events ?? []) {
    const orderIds = Array.isArray(event.order_ids)
      ? event.order_ids.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    if (!orderIds.length) continue

    const { data: unpaid } = await supabase
      .from('orders')
      .select(
        'id, restaurant_id, total, payment_method, payment_status, cancellation_reason, cancelled_at, paycloud_merchant_order_no',
      )
      .in('id', orderIds)
      .neq('payment_status', 'paid')

    if (!unpaid?.length) continue

    const paidAt = new Date().toISOString()
    const merchantNo = String(event.business_order_no || '').trim()
    const autoCancelled = unpaid.filter((row) => isAutoCancelledE04111(row))
    const plain = unpaid.filter((row) => !isAutoCancelledE04111(row))
    const ids = unpaid.map((row) => String(row.id))
    const plainIds = plain.map((row) => String(row.id))

    // Auto-cancelled orders: full confirm path so cancelled_at / cancellation_reason clear
    // and the wrong auto-cancel is surfaced as a critical alert.
    for (const row of autoCancelled) {
      const orderId = String(row.id)
      const restaurantId = String(row.restaurant_id)
      const reference = merchantNo || String(row.paycloud_merchant_order_no || '').trim() || orderId
      try {
        const claim = await markOrderPaidConfirmed(supabase, {
          orderId,
          restaurantId,
          reference,
          amount: Number(row.total) || 0,
          paymentMethod: (row.payment_method as string) || 'card',
          source: 'cron_reconcile_orphan_payments',
          extraAuditMetadata: {
            businessOrderNo: merchantNo || null,
            paymentEventId: String(event.id),
            recoveredAfterAutoCancel: true,
          },
          fromPaymentStatuses: claimableStatusesForRecovery(row),
        })

        if (claim.claimed) {
          markedPaidIds.push(orderId)
          recoveredAfterAutoCancelIds.push(orderId)
          await recordRecoveredAfterAutoCancel(supabase, {
            restaurantId,
            orderId,
            reference,
            source: 'cron_reconcile_orphan_payments',
            previousCancellationReason: row.cancellation_reason
              ? String(row.cancellation_reason)
              : null,
            previousCancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
            amount: Number(row.total) || 0,
            metadata: { paymentEventId: String(event.id) },
          })
        } else {
          console.warn(
            `[reconcileOrphanPayments] auto-cancelled order ${orderId} not claimed (${claim.reason}); retrying next run`,
          )
        }
      } catch (err) {
        // Never let one order abort the sweep -- the rest of this event still reconciles.
        console.error(
          `[reconcileOrphanPayments] recovery of auto-cancelled order ${orderId} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    if (plainIds.length) {
      await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          paid_at: paidAt,
          status: 'completed',
          completed_at: paidAt,
        })
        .in('id', plainIds)
    }

    if (merchantNo) {
      await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: merchantNo.slice(0, 32) })
        .in('id', ids)
        .is('paycloud_merchant_order_no', null)
    }

    for (const id of plainIds) {
      markedPaidIds.push(id)
      await safeIssueReceiptForOrder(id, 'cron/reconcile-orphan-payments')
    }
  }

  // Paid but never issued (issuance failure / race).
  const { data: paidOrders, error: paidError } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_status', 'paid')
    .gte('paid_at', since)
    .order('paid_at', { ascending: false })
    .limit(limit)

  if (paidError) {
    throw new Error(`reconcileOrphanPayments: paid orders: ${paidError.message}`)
  }

  let receiptsIssued = 0
  for (const row of paidOrders ?? []) {
    const orderId = String(row.id)
    const { data: receipt } = await supabase
      .from('receipt_documents')
      .select('id')
      .eq('order_id', orderId)
      .eq('document_type', 'SALE_RECEIPT')
      .limit(1)
      .maybeSingle()

    if (receipt) continue

    await safeIssueReceiptForOrder(orderId, 'cron/reconcile-orphan-payments')
    receiptsIssued += 1
  }

  return {
    markedPaid: markedPaidIds.length,
    markedPaidIds: [...new Set(markedPaidIds)],
    receiptsIssued,
    recoveredAfterAutoCancel: recoveredAfterAutoCancelIds.length,
    recoveredAfterAutoCancelIds: [...new Set(recoveredAfterAutoCancelIds)],
  }
}
