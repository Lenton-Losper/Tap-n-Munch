import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'
import { isCancelledOnE04111Evidence } from '@/lib/payments/e04111-recovery'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
  type FinaticOrderPaidResult,
} from '@/lib/payments/query-finatic-order-paid'
import { settleWholeOrderPayment } from '@/lib/payments/settle-whole-order-payment'
import { bindReferenceToOrders, referenceConsumption } from '@/lib/payments/reconcile-reference'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type ReconcileOrphanPaymentsResult = {
  markedPaid: number
  markedPaidIds: string[]
  receiptsIssued: number
  /** Orders restored after the E04111 auto-cancel rule had cancelled them. */
  recoveredAfterAutoCancel: number
  recoveredAfterAutoCancelIds: string[]
  /**
   * #223. A payment_events 'sale' row whose amount did not agree with the total of the orders
   * it names (or the row's amount was absent, which cannot happen today -- payment_events.amount
   * is NOT NULL -- but is still checked explicitly rather than assumed). Nothing was marked
   * paid; both figures were recorded on every named order for a human to resolve.
   */
  amountMismatchCount: number
  amountMismatchIds: string[]
  /**
   * WORK THIS RUN COULD NOT DO, and why the two are named separately.
   *
   * `ordersLookupsFailed` — events skipped because the orders they name could not be read. Each is
   * an orphaned payment still orphaned; this function exists to find those, so failing to look is
   * unfinished work rather than a clean run.
   *
   * `receiptLookupsFailed` — paid orders whose receipt state could not be read, and which were
   * therefore NOT issued a receipt. Not knowing must mean do not issue: the alternative is a second
   * RCT-numbered tax document for one order, which no later sweep can undo.
   *
   * Both are zero on a healthy run. Non-zero means the next run has work to redo, not that the
   * estate is quiet — a distinction `markedPaid: 0` cannot make on its own.
   */
  ordersLookupsFailed: number
  receiptLookupsFailed: number
  /**
   * Sprint 2026-09-29 task 7. Unpaid orders on an event whose reference could not be bound to them
   * from server state, or was already consumed. Never marked paid; a human resolves them.
   */
  unverifiableCount: number
  unverifiableIds: string[]
  /**
   * Unpaid orders the GATEWAY did not confirm this run: not paid, E04111, no credentials, or
   * unreachable. Never marked paid on the device's word; the next run asks again.
   */
  gatewayUnverifiedCount: number
  gatewayUnverifiedIds: string[]
}

/**
 * Recovery for race / legacy cases:
 * 1) Sale payment_events whose order_ids are still unpaid → ask the GATEWAY, and settle through
 *    settle_order_payment only on its verified figure (Sprint 2026-09-29 task 7; see the loop).
 * 2) Paid orders missing a SALE_RECEIPT → safe-issue.
 *
 * Orders auto-cancelled by the E04111 rule are recovered inside the same RPC call (the
 * allow-list settleWholeOrderPayment builds), which clears cancelled_at / cancellation_reason and
 * records payment.recovered_after_auto_cancel -- so no completed+paid+cancelled row is produced.
 * The old bulk `update({ payment_status: 'paid' })` and its separate #239 audit are gone: the
 * RPC's settlement_applied row and ledger row are the record now.
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
  const amountMismatchIds: string[] = []
  const unverifiableIds: string[] = []
  const gatewayUnverifiedIds: string[] = []

  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('id, restaurant_id, business_order_no, order_ids, amount, transaction_id, created_at')
    .eq('event_type', 'sale')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (eventsError) {
    throw new Error(`reconcileOrphanPayments: payment_events: ${eventsError.message}`)
  }

  /**
   * Counted, not just logged. A run that could not read half its events must be able to SAY so —
   * "0 reconciled" from a healthy quiet night and "0 reconciled" from a failing database look
   * identical otherwise, and only one of them needs somebody.
   */
  let ordersLookupsFailed = 0

  for (const event of events ?? []) {
    const orderIds = Array.isArray(event.order_ids)
      ? event.order_ids.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    if (!orderIds.length) continue
    const restaurantId = String(event.restaurant_id || '').trim()
    const merchantNo = String(event.business_order_no || '').trim()

    // Scoped to the event's own venue: an id the device named in another venue is not found, and
    // an event naming orders that cannot all be found is not reconciled.
    const { data: eventOrders, error: eventOrdersError } = await supabase
      .from('orders')
      .select('id, restaurant_id, total, payment_method, payment_status, cancellation_reason, cancelled_at')
      .eq('restaurant_id', restaurantId)
      .in('id', orderIds)

    /**
     * A RECOVERY PATH MAY NOT ABANDON A PAYMENT IN SILENCE.
     *
     * `if (!eventOrders?.length) continue` treated a FAILED READ exactly like "this event names no
     * orders" — so a transient failure made this loop step over a real orphaned payment with no
     * record that it had done so. Nothing is wrongly marked paid, which is why it never showed up;
     * but this function's entire job is finding money that got lost, and a silent skip on that path
     * is money that stays lost.
     *
     * Absence and failure lead to different actions. An event naming no orders is nothing to do. An
     * event whose orders cannot be READ is unfinished work, and it is now said out loud and counted
     * so a run reports how much of its own job it could not do. Still `continue` — retrying inside
     * the loop would hammer a database that is already failing — and the next run picks it up.
     */
    if (eventOrdersError) {
      ordersLookupsFailed += 1
      console.error('[reconcileOrphanPayments] order lookup failed; event NOT reconciled', {
        businessOrderNo: merchantNo,
        orderIds,
        error: eventOrdersError.message,
      })
      continue
    }

    if (!eventOrders?.length) continue
    const unpaid = eventOrders.filter((row) => String(row.payment_status || '').toLowerCase() !== 'paid')
    // Nothing owed -> nothing to verify, and no gateway call is spent on it.
    if (!unpaid.length) continue
    const unpaidIds = unpaid.map((row) => String(row.id))

    const deviceAmount = Number.isFinite(Number(event.amount)) ? Number(event.amount) : null

    /**
     * ============================================================================================
     * THE EVENT IS A LEAD, NOT EVIDENCE (Sprint 2026-09-29 brief, task 7)
     * ============================================================================================
     *
     * This loop used to compare `event.amount` with the sum of orders.total and, on agreement,
     * mark the orders paid. But a sale row is written by the DEVICE (POST
     * /api/terminal/payment-events/sale) with the device's own `amount` and `order_ids`, and that
     * route records a row even when the amount disagrees with the intent. So a device reporting
     * N$X against orders totalling N$X paid them, with nobody ever asking the gateway: the
     * device's word, twice.
     *
     * Now the event only says WHERE TO LOOK. Every figure that decides anything comes from server
     * state and the gateway:
     *
     *   1. the reference is BOUND to the event's orders from server state -- the intent, or the
     *      orders prepare-payment stamped it on, expanded to their settlement target -- and the
     *      event's order_ids must be exactly that set (bindReferenceToOrders);
     *   2. it is not already CONSUMED by a verified payment (referenceConsumption);
     *   3. Finatic is asked. Not paid, no record, no credentials, unreachable -> NOTHING is marked
     *      paid; the event is retried next run;
     *   4. Finatic's own paid amount -- never the device's -- goes to settleWholeOrderPayment, which
     *      checks it against the target's expected charge (intent amount_cents /
     *      pending_charge_cents) and applies it through settle_order_payment: ledger row, audit
     *      row, settled_charge_cents, intent consumed, E04111 recovery -- one transaction.
     *
     * The device's amount is kept only to be REPORTED when it disagrees with the gateway.
     */
    const bound = restaurantId
      ? await bindReferenceToOrders(supabase, { restaurantId, merchantOrderNo: merchantNo, orderIds })
      : ({ ok: false, code: 'REFERENCE_UNKNOWN', detail: 'event has no restaurant' } as const)
    if (!bound.ok) {
      if (bound.code === 'REFERENCE_UNREADABLE') ordersLookupsFailed += 1
      else unverifiableIds.push(...unpaidIds)
      console.error('[reconcileOrphanPayments] reference not bound to the event orders; NOT marking paid', {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        code: bound.code,
        detail: bound.detail,
      })
      continue
    }

    const consumption = await referenceConsumption(supabase, {
      restaurantId,
      merchantOrderNo: merchantNo,
      intent: bound.intent,
    })
    if (consumption.consumed === null) {
      ordersLookupsFailed += 1
      continue
    }
    if (consumption.consumed) {
      unverifiableIds.push(...unpaidIds)
      console.error('[reconcileOrphanPayments] reference already consumed; NOT marking paid', {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        detail: consumption.detail,
      })
      continue
    }

    let finatic: FinaticOrderPaidResult
    try {
      const credentials = await getRestaurantFinaticCredentials(restaurantId)
      finatic = await queryFinaticOrderPaid({
        merchantOrderNo: merchantNo,
        merchantNo: credentials.merchantNo,
        storeNo: credentials.storeNo,
      })
    } catch (err) {
      // E04111 is "no record YET" -- never "not paid" and never "paid". Missing credentials and an
      // unreachable gateway are the same answer here: unverified, so nothing is applied.
      gatewayUnverifiedIds.push(...unpaidIds)
      console.error('[reconcileOrphanPayments] gateway could not confirm; NOT marking paid', {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        e04111: isFinaticMerchantOrderInvalidError(err),
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (!finatic.paid) {
      gatewayUnverifiedIds.push(...unpaidIds)
      console.warn('[reconcileOrphanPayments] gateway does not report paid; NOT marking paid', {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        status: finatic.status,
      })
      continue
    }

    // The device's figure, REPORTED when it disagrees with the gateway's. Never used to decide.
    if (
      deviceAmount !== null &&
      finatic.amount !== null &&
      Math.round(deviceAmount * 100) !== Math.round(finatic.amount * 100)
    ) {
      const { error: deviceAuditError } = await supabase.from('audit_logs').insert(
        unpaidIds.map((orderId) => ({
          restaurant_id: restaurantId,
          action: 'payment.device_amount_disagrees_with_gateway',
          entity_type: 'order',
          entity_id: orderId,
          metadata: {
            paymentEventId: String(event.id),
            businessOrderNo: merchantNo,
            deviceReportedAmount: deviceAmount,
            gatewayAmount: finatic.amount,
            source: 'cron_reconcile_orphan_payments',
          },
        })),
      )
      if (deviceAuditError) {
        console.error('[reconcileOrphanPayments] device-amount audit failed:', deviceAuditError)
      }
    }

    // Decided from the rows as READ, before the settlement changes them.
    const autoCancelledIds = new Set(
      unpaid.filter((row) => isCancelledOnE04111Evidence(row)).map((row) => String(row.id)),
    )

    const settled = await settleWholeOrderPayment(supabase, {
      restaurantId,
      leadOrderIds: bound.leadOrderIds,
      intent: bound.intent,
      merchantOrderNo: merchantNo,
      transactionId: finatic.transactionId,
      // THE GATEWAY'S FIGURE. Substituting `deviceAmount` here is the task-7 defect.
      gatewayAmount: finatic.amount,
      // F3: Finatic has just confirmed a card charge on this reference -- established, not defaulted.
      paymentMethod: 'card',
      source: 'cron_reconcile_orphan_payments',
      mismatchSource: 'reconcile_orphan_payments',
      extraAuditMetadata: {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        deviceReportedAmount: deviceAmount,
        finaticAmount: finatic.amount,
        finaticTransactionId: finatic.transactionId,
      },
    })

    if (!settled.ok) {
      // amount_mismatch: settleWholeOrderPayment has already written payment.amount_mismatch and
      // payment.verification_uncertain on every covered order.
      if (settled.reason === 'amount_mismatch') amountMismatchIds.push(...unpaidIds)
      console.error('[reconcileOrphanPayments] settlement not applied', {
        paymentEventId: String(event.id),
        businessOrderNo: merchantNo,
        reason: settled.reason,
      })
      continue
    }

    markedPaidIds.push(...settled.claimedOrderIds)
    recoveredAfterAutoCancelIds.push(...settled.claimedOrderIds.filter((id) => autoCancelledIds.has(id)))
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
  let receiptLookupsFailed = 0
  for (const row of paidOrders ?? []) {
    const orderId = String(row.id)
    const { data: receipt, error: receiptError } = await supabase
      .from('receipt_documents')
      .select('id')
      .eq('order_id', orderId)
      .eq('document_type', 'SALE_RECEIPT')
      .limit(1)
      .maybeSingle()

    /**
     * NOT KNOWING MEANS DO NOT ISSUE.
     *
     * The error used to be discarded, so a failed read produced `receipt === null` — identical to
     * "this order has no receipt" — and this loop issued another one. That is a DUPLICATE
     * RCT-NUMBERED TAX DOCUMENT for a single order, minted by a cron with nobody watching, from a
     * transient database failure.
     *
     * Absence and failure lead to opposite actions here, so they need different code paths. An
     * order whose receipt state cannot be read is left for the next run, which is harmless: the
     * receipt either exists already or is still missing, and one more sweep costs nothing. Issuing
     * a second tax document cannot be undone by a later sweep.
     */
    if (receiptError) {
      receiptLookupsFailed += 1
      console.error('[reconcileOrphanPayments] receipt lookup failed; NOT issuing', {
        orderId,
        error: receiptError.message,
      })
      continue
    }

    if (receipt) continue

    await safeIssueReceiptForOrder(orderId, 'cron/reconcile-orphan-payments')
    receiptsIssued += 1
  }

  if (receiptLookupsFailed > 0) {
    console.error('[reconcileOrphanPayments] receipt lookups failed this run', {
      receiptLookupsFailed,
      note: 'those orders were skipped rather than re-issued; the next run retries them',
    })
  }

  return {
    markedPaid: markedPaidIds.length,
    markedPaidIds: [...new Set(markedPaidIds)],
    receiptsIssued,
    recoveredAfterAutoCancel: recoveredAfterAutoCancelIds.length,
    recoveredAfterAutoCancelIds: [...new Set(recoveredAfterAutoCancelIds)],
    amountMismatchCount: amountMismatchIds.length,
    amountMismatchIds: [...new Set(amountMismatchIds)],
    /**
     * WORK THIS RUN COULD NOT DO. Reported rather than buried, so a caller can tell a quiet night
     * from a failing database — both otherwise report markedPaid: 0.
     */
    ordersLookupsFailed,
    receiptLookupsFailed,
    unverifiableCount: new Set(unverifiableIds).size,
    unverifiableIds: [...new Set(unverifiableIds)],
    gatewayUnverifiedCount: new Set(gatewayUnverifiedIds).size,
    gatewayUnverifiedIds: [...new Set(gatewayUnverifiedIds)],
  }
}
