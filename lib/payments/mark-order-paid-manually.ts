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
 *   AN IMMUTABLE LEDGER ROW, in the same transaction as the payment (Sprint 2026-09-29 brief).
 *   `record_manual_order_payment` (20260929100000) makes the conditional claim, writes the
 *   `payments` settlement anchor, the `non_gateway_payment_events` ledger row and the
 *   `payment.marked_paid_manually` audit row as ONE transaction: all of them land or none do. The
 *   route-level undo this replaced (put the order back, DELETE the payments row) is gone, because a
 *   ledger that can be deleted on an error path is not immutable.
 *
 * THE RECORDED RULING THIS REVERSES. This header used to say "NO payment_events ROW, deliberately":
 * the tab settle route's F2 ruling that the gateway ledger must not hold a cash row, which left a
 * manual payment with no ledger record at all. The Sprint 2026-09-29 brief overrules the "no ledger
 * record" half -- EVERY SUCCESSFUL PAYMENT MUST HAVE AN IMMUTABLE FINANCIAL LEDGER RECORD -- and keeps
 * the other half: the row goes in `non_gateway_payment_events`, never in `payment_events`, so no
 * reader of the gateway ledger can mistake it for a gateway transaction. It carries no gateway field
 * at all; `origin` says a member of staff recorded it, `method` says how the customer paid.
 *
 * IDEMPOTENT twice over: the claim is conditioned on the payment_status that was read, and the
 * ledger key is `staff_mark_paid:<order id>` UNIQUE per restaurant, so a double click or a replay
 * cannot produce a second row.
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
      /** The non_gateway_payment_events row this payment is recorded by. */
      ledgerEventId: string
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
  },
): Promise<ManualPaymentResult> {
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
  try {
    const loaded = await loadOrderFinancials(supabase, params.restaurantId, [params.orderId])
    const financials = loaded.byId.get(params.orderId)
    if (!financials) return refuse(404, 'ORDER_NOT_FOUND', 'Order not found')
    amountCents = financials.outstandingCents
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

  /**
   * ONE TRANSACTION: claim, settlement anchor, ledger row, audit row (20260929100000). The claim
   * inside is conditioned on the payment_status that was READ and validated above, and scoped to
   * this restaurant, so a payment landing from anywhere else in between is a refusal, never an
   * overwrite -- and another venue's order is simply not found.
   */
  let rpcData: unknown = null
  let rpcError: { code?: string; message?: string } | null = null
  try {
    const res = await supabase.rpc('record_manual_order_payment', {
      p_restaurant_id: params.restaurantId,
      p_order_id: params.orderId,
      p_expected_payment_status:
        params.currentPaymentStatus == null ? null : String(params.currentPaymentStatus),
      p_method: method,
      // THE SERVER'S FIGURE, from the projection above. Never a client amount.
      p_amount_cents: amountCents,
      p_payment_reference: paymentReference,
      p_staff_user_id: params.staffUserId,
      p_source: 'orders/status',
    })
    rpcData = res.data
    rpcError = res.error
  } catch (thrown) {
    rpcError = { message: thrown instanceof Error ? thrown.message : String(thrown) }
  }

  if (rpcError) {
    // The ledger key refused a second manual payment of this order: it has one already.
    if (rpcError.code === '23505') {
      return refuse(409, 'ALREADY_PAID', 'This order already has a recorded payment.')
    }
    console.error('[markOrderPaidManually] payment not recorded', {
      orderId: params.orderId,
      error: rpcError.message,
    })
    // Atomic: nothing was written, so "nothing was changed" is the truth, not a hope.
    return refuse(
      503,
      'PAYMENT_TRAIL_NOT_RECORDED',
      'The payment could not be recorded. Nothing was changed — try again.',
    )
  }

  const result = (rpcData ?? {}) as {
    ok?: boolean
    reason?: string
    ledger_event_id?: string
    payment_id?: string
  }
  if (result.ok !== true) {
    switch (result.reason) {
      case 'order_not_found':
        return refuse(404, 'ORDER_NOT_FOUND', 'Order not found')
      case 'already_paid':
        return refuse(409, 'ALREADY_PAID', 'This order is already paid.')
      case 'not_settleable':
        return refuse(
          409,
          'PAYMENT_STATUS_NOT_SETTLEABLE',
          'This order cannot be marked paid from its current payment state. Refresh and try again.',
        )
      default:
        return refuse(409, 'PAYMENT_STATUS_CHANGED', 'Payment status changed; refresh and try again')
    }
  }

  // The committed row, for the response. A failed re-read does not undo a recorded payment.
  const { data: order } = await supabase
    .from('orders')
    .select('id, payment_status, payment_method, payment_reference, paid_at, status, is_closed, cancelled_at')
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .maybeSingle()

  return {
    ok: true,
    order: (order as Record<string, unknown> | null) ?? {
      id: params.orderId,
      payment_status: 'paid',
      payment_method: method,
      payment_reference: paymentReference,
    },
    method,
    amountCents,
    paymentReference,
    paymentRecordWritten: true,
    ledgerEventId: String(result.ledger_event_id ?? ''),
  }
}
