import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type ReconcileOrphanPaymentsResult = {
  markedPaid: number
  markedPaidIds: string[]
  receiptsIssued: number
}

/**
 * Recovery for race / legacy cases:
 * 1) Sale payment_events whose order_ids are still unpaid → mark paid + backfill merchant no.
 * 2) Paid orders missing a SALE_RECEIPT → safe-issue.
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
      .select('id, payment_status, paycloud_merchant_order_no')
      .in('id', orderIds)
      .neq('payment_status', 'paid')

    if (!unpaid?.length) continue

    const paidAt = new Date().toISOString()
    const ids = unpaid.map((row) => String(row.id))
    const merchantNo = String(event.business_order_no || '').trim()

    await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        paid_at: paidAt,
        status: 'completed',
        completed_at: paidAt,
      })
      .in('id', ids)

    if (merchantNo) {
      await supabase
        .from('orders')
        .update({ paycloud_merchant_order_no: merchantNo.slice(0, 32) })
        .in('id', ids)
        .is('paycloud_merchant_order_no', null)
    }

    for (const id of ids) {
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
  }
}
