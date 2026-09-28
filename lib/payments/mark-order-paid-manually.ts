/**
 * STAFF "MARK AS PAID" — the one manual paid writer, and it leaves a trail (Sprint 2026-09-28, N1).
 *
 * `PATCH /api/orders/[orderId]/status` accepted ANY payment_status and wrote it with no transition
 * check. The dashboard's Mark-as-Paid button set `paid` with no method, no reference, no amount and
 * no audit row -- then issued a receipt. The same body could move a paid order back to `pending`
 * (so it would be charged again) or a cancelled order to `paid`. A grep for a literal 'paid' write
 * does not find it, because the value came from the request.
 *
 * What a manual payment now has to be:
 *
 *   A METHOD, named by the person recording it -- cash, card (a standalone machine) or PayToday.
 *   No default: an unnamed method is how a card sale books as cash (F3).
 *
 *   A LEGAL TRANSITION from the status the order is actually in: only the cash-settleable states
 *   (`pending`, `unpaid`, `cash_pending`, `failed`). Paid stays paid -- a reversal is a refund, not
 *   a walk-back (payment-state-machine.ts, invariant 8). Cancelled is refused (the E04111 recovery
 *   is a gateway-proven path, never a button). A live card attempt and a held-for-review order are
 *   refused because a card payment is or may be attached to them already.
 *
 *   THE SERVER'S AMOUNT: the order's live outstanding figure from lib/orders/order-financials.ts
 *   (original − voided − already collected). Nothing from the client. Recorded as the order's
 *   `settled_charge_cents`, so the projection reads `paid` as what was actually collected.
 *
 *   A DURABLE RECORD, written or the payment is undone. The `payments` row is the settlement anchor
 *   the tab settle route writes for the same methods; the `audit_logs` row is the trail and is
 *   REQUIRED -- if it cannot be written the order is put back and the request fails, so a paid
 *   order can never exist from this path without one.
 *
 * NO payment_events ROW, deliberately. That table is the gateway ledger, keyed on a gateway
 * reference; the tab settle route's recorded ruling (F2) is that a cash or PayToday row there "can
 * never be matched to anything -- worse than an absence, because it looks reconciled". A manual
 * card payment on a standalone machine has no FlashTap gateway reference either.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { generatePaymentReference } from '@/lib/payment-reference'
import { loadOrderFinancials } from '@/lib/orders/order-financials'
import {
  isCashSettleablePaymentStatus,
  isHeldForReviewPaymentStatus,
  isMidFlightCardPayment,
  normalizeSettlementPaymentMethod,
  type SettlementPaymentMethod,
} from '@/lib/payments/payment-integrity'
import { canTransition, normalizePaymentStatus } from '@/lib/payments/payment-state-machine'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** audit_logs.action for a payment a member of staff recorded by hand. */
export const MANUAL_PAYMENT_ACTION = 'payment.marked_paid_manually'

export type ManualPaymentRefusal = {
  ok: false
  status: number
  code: string
  error: string
}

export type ManualPaymentResult =
  | {
      ok: true
      order: Record<string, unknown>
      method: SettlementPaymentMethod
      amountCents: number
      paymentReference: string
      paymentRecordWritten: boolean
    }
  | ManualPaymentRefusal

const refuse = (status: number, code: string, error: string): ManualPaymentRefusal => ({
  ok: false,
  status,
  code,
  error,
})

export async function markOrderPaidManually(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    staffUserId: string | null
    /** As the client sent it. Validated here, never defaulted. */
    method: unknown
    /** The payment_status the caller read -- the claim below is conditioned on it. */
    currentPaymentStatus: unknown
    /** The payment columns as read, so an undo puts them back exactly. */
    previous?: {
      payment_method?: unknown
      payment_reference?: unknown
      paid_at?: unknown
      settled_charge_cents?: unknown
    }
  },
): Promise<ManualPaymentResult> {
  // Snapshotted before anything is written, so an undo restores what was READ even if the caller's
  // object is the row itself.
  const previous = {
    payment_method: params.previous?.payment_method ?? null,
    payment_reference: params.previous?.payment_reference ?? null,
    paid_at: params.previous?.paid_at ?? null,
    settled_charge_cents: params.previous?.settled_charge_cents ?? null,
  }
  const method = normalizeSettlementPaymentMethod(params.method)
  if (!method) {
    return refuse(
      400,
      'PAYMENT_METHOD_REQUIRED',
      'Choose how this order was paid (cash, card or PayToday) before marking it paid.',
    )
  }

  const from = normalizePaymentStatus(params.currentPaymentStatus)
  if (from === 'paid') {
    return refuse(409, 'ALREADY_PAID', 'This order is already paid.')
  }
  if (from === 'cancelled') {
    return refuse(409, 'ORDER_CANCELLED', 'This order was cancelled and cannot be marked paid.')
  }
  if (isMidFlightCardPayment(from)) {
    return refuse(
      409,
      'CARD_PAYMENT_IN_FLIGHT',
      'A card payment is in progress for this order. Cancel it on the terminal first.',
    )
  }
  if (isHeldForReviewPaymentStatus(from)) {
    return refuse(
      409,
      'HELD_FOR_REVIEW',
      'This order is held for review because a card payment may already exist against it. ' +
        'Resolve it from Held for review instead.',
    )
  }
  if (!isCashSettleablePaymentStatus(from) || !canTransition(from, 'paid').ok) {
    return refuse(
      409,
      'PAYMENT_STATUS_NOT_SETTLEABLE',
      'This order cannot be marked paid from its current payment state. Refresh and try again.',
    )
  }

  // THE SERVER'S FIGURE. Fails closed: not being able to see what was voided or already collected
  // is not permission to record a payment for it.
  let amountCents: number
  let tabId: string | null = null
  try {
    const loaded = await loadOrderFinancials(supabase, params.restaurantId, [params.orderId])
    const financials = loaded.byId.get(params.orderId)
    if (!financials) return refuse(404, 'ORDER_NOT_FOUND', 'Order not found')
    amountCents = financials.outstandingCents
    const row = loaded.rows.find((r) => String(r.id) === params.orderId)
    tabId = row?.tab_id ? String(row.tab_id) : null
  } catch (e) {
    console.error('[markOrderPaidManually] could not read what is owed', {
      orderId: params.orderId,
      error: e instanceof Error ? e.message : String(e),
    })
    return refuse(503, 'SETTLED_TOTAL_UNREADABLE', 'Could not read what is still owed. Try again.')
  }
  if (amountCents <= 0) {
    return refuse(
      409,
      'NOTHING_LEFT_TO_CHARGE',
      'Nothing is owed on this order (its items were voided or already paid for).',
    )
  }

  const paymentReference = generatePaymentReference()
  const paidAt = new Date().toISOString()

  // The conditional claim on the status that was READ and validated above: a payment landing from
  // anywhere else in between makes this match nothing, which is a 409, never an overwrite.
  const { data: claimed, error: claimError } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      payment_method: method,
      payment_reference: paymentReference,
      paid_at: paidAt,
      // Explicit, so the settled-charge trigger keeps it: what THIS payment collected.
      settled_charge_cents: amountCents,
    })
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .eq('payment_status', String(params.currentPaymentStatus))
    .select('id, payment_status, payment_method, payment_reference, paid_at, status, is_closed, cancelled_at')
    .maybeSingle()

  if (claimError) return refuse(400, 'PAYMENT_UPDATE_FAILED', claimError.message)
  if (!claimed) {
    return refuse(409, 'PAYMENT_STATUS_CHANGED', 'Payment status changed; refresh and try again')
  }

  const amount = amountCents / 100

  // The settlement anchor, the same row the tab settle route writes for the same methods.
  const { data: paymentRow, error: paymentError } = await supabase
    .from('payments')
    .insert({
      restaurant_id: params.restaurantId,
      tab_id: tabId,
      order_ids: [params.orderId],
      amount,
      method,
      status: 'completed',
      gateway_reference: null,
      payment_reference: paymentReference,
      completed_at: paidAt,
    })
    .select('id')
    .maybeSingle()
  if (paymentError) {
    console.error('[markOrderPaidManually] payments row not written', {
      orderId: params.orderId,
      error: paymentError.message,
    })
  }

  let auditWritten = false
  try {
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: params.restaurantId,
      action: MANUAL_PAYMENT_ACTION,
      entity_type: 'order',
      entity_id: params.orderId,
      metadata: {
        source: 'orders/status',
        staff_user_id: params.staffUserId,
        method,
        amount,
        amount_cents: amountCents,
        amount_basis: 'order_financials_outstanding',
        previous_payment_status: from,
        payment_reference: paymentReference,
        // Stated, not implied: nothing but this person's word stands behind a manual payment.
        gateway_verified: false,
        payment_record_written: !paymentError,
        recorded_at: paidAt,
      },
    })
    auditWritten = !auditError
    if (auditError) console.error('[markOrderPaidManually] audit insert failed', auditError)
  } catch (thrown) {
    console.error('[markOrderPaidManually] audit insert threw', thrown)
  }

  if (!auditWritten) {
    /**
     * NO TRAIL, NO PAYMENT. Put the order back exactly as it was read -- conditioned on this
     * request's own reference so nothing another writer did since is touched -- and fail.
     */
    const { error: revertError } = await supabase
      .from('orders')
      .update({
        payment_status: params.currentPaymentStatus as string,
        payment_method: previous.payment_method as string | null,
        payment_reference: previous.payment_reference as string | null,
        paid_at: previous.paid_at as string | null,
        settled_charge_cents: previous.settled_charge_cents as number | null,
      })
      .eq('id', params.orderId)
      .eq('restaurant_id', params.restaurantId)
      .eq('payment_reference', paymentReference)
    if (revertError) {
      console.error('[markOrderPaidManually] ORDER LEFT PAID WITHOUT AN AUDIT ROW', {
        orderId: params.orderId,
        paymentReference,
        error: revertError.message,
      })
    }
    if (paymentRow?.id) {
      try {
        await supabase.from('payments').delete().eq('id', String(paymentRow.id))
      } catch (thrown) {
        console.error('[markOrderPaidManually] could not remove the payments row', thrown)
      }
    }
    return refuse(
      503,
      'PAYMENT_TRAIL_NOT_RECORDED',
      'The payment could not be recorded. Nothing was changed — try again.',
    )
  }

  return {
    ok: true,
    order: claimed as Record<string, unknown>,
    method,
    amountCents,
    paymentReference,
    paymentRecordWritten: !paymentError,
  }
}
