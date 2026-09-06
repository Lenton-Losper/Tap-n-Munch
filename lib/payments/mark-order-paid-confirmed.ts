import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { CLAIMABLE_PAYMENT_STATUSES, owesMoney } from '@/lib/payments/payment-integrity'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type MarkOrderPaidConfirmedParams = {
  orderId: string
  restaurantId: string
  reference: string
  voucherNo?: string | null
  paymentMethod?: string
  /**
   * What the caller asserts was paid. Its MEANING differs per caller, which is why the audit
   * entry now says so explicitly rather than labelling it `clientAmount` (#238):
   *
   *   terminal_callback / terminal_verify_payment  the ORDER's own total
   *   paycloud webhook / reconcile cron            the ORDER's own total
   *   auto_cancel_cron_finatic_verified            Finatic's figure, falling back to the total
   *   terminal payment failure correction          Finatic's figure
   *
   * Pass `gatewayAmount` alongside it whenever the provider's own figure is known.
   */
  amount: number
  /**
   * The PROVIDER's own figure for this payment, when the caller has one (#268).
   *
   * `undefined` means "not known here" and is recorded as such — it is NOT the same as the
   * gateway reporting zero, and the audit entry must never let those two read alike.
   */
  gatewayAmount?: number | null
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
    gatewayAmount,
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
    /**
     * WHOSE FIGURE IS THIS? (#238, #268)
     *
     * `clientAmount: amount` used to sit here, duplicating `amount` under a name that was wrong
     * for most callers. Measured across all six call sites: four pass the ORDER'S OWN TOTAL
     * (terminal callback, terminal verify-payment, the PayCloud webhook, the reconcile cron) and
     * two pass FINATIC'S figure (the auto-cancel cron's pre-cancel check, and the terminal
     * payment-failure correction). So the field was not the client's amount in four cases and
     * was not the client's amount in the other two either -- it was simply `amount` again, under
     * a label that made a historical mismatch look investigable when it was not.
     *
     * Nothing read it. Grepped `clientAmount` across *.ts, *.tsx, *.sql, __tests__ and the
     * terminal app: the only other hits are unrelated local variables in the receipt route and a
     * parameter name in payment-integrity. It was write-only, which is why correcting it is safe.
     *
     * Now: `amount` is what the caller asserted, `amountMeaning` says whose figure that is, and
     * `gatewayAmount` carries the provider's own number when the caller has one. A mismatch
     * between the last two is the thing #268 wants auditable.
     */
    metadata: {
      reference,
      voucherNo: paymentVoucherNo,
      businessOrderNo: reference,
      amount,
      // `null` = the caller had no provider figure. Deliberately distinct from a gateway that
      // genuinely reported 0, which would record as 0.
      gatewayAmount: gatewayAmount ?? null,
      amountMeaning: gatewayAmount != null ? 'gateway_reported' : 'order_total',
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
    // Partitioned with owesMoney(), not `.neq('payment_status','paid')` -- "not paid" is also
    // true of a CANCELLED order, so a cancelled order's money kept being carried in tabs.total
    // (#104, the fifth site of the same question; the other four are in the terminal routes).
    // This one matters doubly because the caller at
    // app/api/terminal/orders/[orderId]/payment/route.ts recomputes canClose two statements
    // later: while these disagreed, one request wrote can_close true and a tab total that
    // still owed money, and /api/terminal/tables hands staff both figures at once.
    const { data: tabOrderRows, error: tabOrderRowsError } = await supabase
      .from('orders')
      .select('total, payment_status')
      .eq('tab_id', tabId)

    /**
     * A FAILED READ MUST NOT BECOME A TAB TOTAL OF ZERO.
     *
     * The error used to be discarded, so `tabOrderRows` came back null on any failure, `?? []`
     * turned it into an empty list, and the reduce produced 0 — which was then WRITTEN. A
     * transient database failure set a tab that still owed money to N$0.00.
     *
     * That is precisely the defect the comment above says this code exists to prevent: a tab total
     * that disagrees with what is owed, handed to staff by /api/terminal/tables alongside a
     * can_close figure computed from something else. The guard against it could produce it.
     *
     * Absence and failure lead to different actions. A tab whose orders cannot be read keeps the
     * total it already has — stale, and honest about being stale — rather than being overwritten
     * with a number nothing computed. The next settle on the tab recomputes it.
     */
    if (tabOrderRowsError) {
      console.error(`[markOrderPaidConfirmed:${source}] tab total NOT recomputed; read failed`, {
        tabId,
        orderId,
        error: tabOrderRowsError.message,
        note: 'the tab keeps its previous total rather than being zeroed',
      })
    } else {
      const newTotal = (tabOrderRows ?? [])
        .filter((o: { payment_status: unknown }) => owesMoney(o.payment_status))
        .reduce((sum: number, o: { total: unknown }) => sum + Number(o.total), 0)

      // The write's own error was discarded too, so a total that silently failed to persist looked
      // exactly like one that succeeded.
      const { error: tabUpdateError } = await supabase
        .from('tabs')
        .update({ total: newTotal })
        .eq('id', tabId)
      if (tabUpdateError) {
        console.error(`[markOrderPaidConfirmed:${source}] tab total write failed`, {
          tabId,
          newTotal,
          error: tabUpdateError.message,
        })
      }
    }
  }

  await safeIssueReceiptForOrder(orderId, source)

  return { claimed: true, orderId, tabId }
}
