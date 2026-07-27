import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { CLAIMABLE_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type MarkOrderPaidConfirmedParams = {
  orderId: string
  restaurantId: string
  reference: string
  voucherNo?: string | null
  paymentMethod?: string
  amount: number
  terminalId?: string | null
  /** Short tag identifying the caller for the audit_logs entry, e.g. 'terminal_callback', 'auto_cancel_cron_finatic_verified', 'terminal_verify_payment', 'staff_reconcile'. */
  source: string
  /** Extra metadata merged into the audit_logs entry (e.g. correctionReason). */
  extraAuditMetadata?: Record<string, unknown>
  /** payment_status values eligible to transition from. Defaults to the standard claimable set. */
  fromPaymentStatuses?: readonly string[]
}

export type MarkOrderPaidConfirmedResult =
  | { claimed: true; orderId: string; tabId: string | null }
  | { claimed: false; reason: 'already_paid' | 'claim_conflict' }

/**
 * Single source of truth for "an order is now confirmed paid" (payment_status=paid,
 * status=completed, real gateway reference recorded, audit_logs entry, receipt issued,
 * tab total recomputed if tab-linked). Mirrors exactly what the terminal's own
 * status=success callback does (app/api/terminal/orders/[orderId]/payment/route.ts),
 * so every caller that learns "this order was actually paid" -- the live terminal
 * callback, a Finatic verify-payment check, the auto-cancel cron's pre-cancel check,
 * or a manual reconcile -- ends up in the identical final state with the identical
 * audit trail, rather than each reimplementing a slightly different version.
 *
 * Atomic: the claim UPDATE re-checks payment_status is still in fromPaymentStatuses,
 * so concurrent callers (e.g. a live terminal callback racing this cron's check) can
 * only apply the correction once; the loser gets claimed:false, not an error.
 */
export async function markOrderPaidConfirmed(
  supabase: Supabase,
  params: MarkOrderPaidConfirmedParams,
): Promise<MarkOrderPaidConfirmedResult> {
  const {
    orderId,
    restaurantId,
    reference,
    voucherNo,
    paymentMethod = 'card',
    amount,
    terminalId = null,
    source,
    extraAuditMetadata,
    fromPaymentStatuses = CLAIMABLE_PAYMENT_STATUSES,
  } = params

  const paidAt = new Date().toISOString()
  const paymentVoucherNo = voucherNo || reference || null

  const { data: claimed, error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'completed',
      payment_status: 'paid',
      payment_method: paymentMethod,
      payment_reference: reference,
      payment_voucher_no: paymentVoucherNo,
      paid_at: paidAt,
      completed_at: paidAt,
      cancellation_reason: null,
      cancelled_at: null,
    })
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .in('payment_status', [...fromPaymentStatuses])
    .select('id, tab_id, payment_status')
    .maybeSingle()

  if (updateError) throw updateError

  if (!claimed) {
    const { data: current } = await supabase
      .from('orders')
      .select('payment_status')
      .eq('id', orderId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    const reason =
      String(current?.payment_status || '').toLowerCase() === 'paid' ? 'already_paid' : 'claim_conflict'
    return { claimed: false, reason }
  }

  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    action: 'payment.completed',
    entity_type: 'order',
    entity_id: orderId,
    metadata: {
      reference,
      voucherNo: paymentVoucherNo,
      businessOrderNo: reference,
      amount,
      clientAmount: amount,
      paymentMethod,
      terminalId,
      source,
      ...extraAuditMetadata,
    },
  })
  if (auditError) {
    console.error(`[markOrderPaidConfirmed:${source}] audit_logs insert failed:`, auditError)
  }

  const tabId = claimed.tab_id ? String(claimed.tab_id) : null
  if (tabId) {
    const { data: unpaidOrders } = await supabase
      .from('orders')
      .select('total')
      .eq('tab_id', tabId)
      .neq('payment_status', 'paid')
    const newTotal = (unpaidOrders ?? []).reduce((sum: number, o: { total: unknown }) => sum + Number(o.total), 0)
    await supabase.from('tabs').update({ total: newTotal }).eq('id', tabId)
  }

  await safeIssueReceiptForOrder(orderId, source)

  return { claimed: true, orderId, tabId }
}
