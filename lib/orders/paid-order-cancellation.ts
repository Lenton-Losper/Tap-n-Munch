/**
 * MAY THIS ORDER BE CANCELLED, GIVEN THE MONEY ON IT? (Sprint 2026-09-29 brief, F-MANUAL task 2.)
 *
 * ================================================================================================
 * THE DEFECT
 * ================================================================================================
 *
 * Every cancel writer sets `status = 'cancelled'` AND `payment_status = 'cancelled'`. The staff
 * status route allowed that from any kitchen status but completed/cancelled -- including an order
 * marked paid by hand while still `preparing`, a QR order paid before the kitchen started, or an
 * order half paid through the item ledger -- and the terminal's pre-gateway cancel ran with
 * `guard: 'none'`. Either one turned a PAID order into a "cancelled payment": the money was still
 * in the drawer or on the card, and every report stopped counting it.
 *
 * ================================================================================================
 * THE STATE MODEL THIS ENFORCES
 * ================================================================================================
 *
 * `orders.payment_status` has NO 'refunded' value (orders_payment_status_enumerated, 20260919091000).
 * Paid stays paid (payment-state-machine.ts invariant 8); a reversal is a REFUND, recorded as
 * `payment_events` refund rows against the sale, and `refunded` / `partially_refunded` are DERIVED
 * by lib/payments/get-payment-projection.ts. The only refund mechanism FlashTap has is the gateway
 * refund on the terminal (POST /api/terminal/payment-events/refund, RefundAuth PIN). A cash,
 * PayToday or standalone-card payment has NO in-system refund.
 *
 *   no money on the order                    -> cancellable, exactly as before
 *   paid / part-paid, not refunded            -> REFUSED: ORDER_PAID_REFUND_REQUIRED /
 *                                                ORDER_PARTIALLY_PAID_REFUND_REQUIRED, naming the
 *                                                refund path (or saying there is none in FlashTap)
 *   a gateway sale fully refunded             -> cancellable, and the cancel must PRESERVE
 *                                                payment_status: the sale and its refund are the
 *                                                history, 'cancelled' would erase the first half
 *
 * Evidence of money, any one of which counts: payment_status 'paid'; a gateway sale row naming the
 * order (payment_events); a settled item allocation; a non-gateway ledger row naming the order.
 *
 * FAILS CLOSED. Not being able to read the payment state is not permission to cancel over it.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import { normalizePaymentStatus } from '@/lib/payments/payment-state-machine'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type CancellationRefundPath =
  /** A gateway card sale: refund it on the terminal (Refund, manager PIN), then cancel. */
  | 'terminal_card_refund'
  /** Cash / PayToday / standalone card: FlashTap has no refund for it. */
  | 'none_in_flashtap'

export type PaidCancellationCheck =
  | {
      allowed: true
      /** True when the order was paid and the gateway sale has been fully refunded. */
      fullyRefunded: boolean
    }
  | {
      allowed: false
      status: number
      code:
        | 'ORDER_PAID_REFUND_REQUIRED'
        | 'ORDER_PARTIALLY_PAID_REFUND_REQUIRED'
        | 'PAYMENT_STATE_UNREADABLE'
      error: string
      refundPath: CancellationRefundPath | null
    }

const REFUND_ON_TERMINAL =
  'Refund the card payment on the terminal first (Refund, with a manager PIN), then cancel the order.'
const NO_REFUND_IN_FLASHTAP =
  'FlashTap cannot refund a cash, PayToday or standalone-card payment, so the order stays paid. ' +
  'Give the money back outside FlashTap; the payment record is kept as it is.'

export async function checkPaidOrderCancellation(
  supabase: Supabase,
  params: { restaurantId: string; orderId: string; paymentStatus: unknown },
): Promise<PaidCancellationCheck> {
  const paid = normalizePaymentStatus(params.paymentStatus) === 'paid'

  let settledAllocations = 0
  let nonGatewayRows = 0
  let projection: Awaited<ReturnType<typeof getPaymentProjections>> | null = null
  try {
    const { data: allocations, error: allocError } = await supabase
      .from('order_line_allocations')
      .select('id, settled_at')
      .eq('restaurant_id', params.restaurantId)
      .eq('order_id', params.orderId)
    if (allocError) throw new Error(allocError.message)
    settledAllocations = ((allocations ?? []) as Array<{ settled_at?: unknown }>).filter(
      (a) => a.settled_at != null,
    ).length

    const { data: ledgerRows, error: ledgerError } = await supabase
      .from('non_gateway_payment_events')
      .select('id')
      .eq('restaurant_id', params.restaurantId)
      .contains('order_ids', [params.orderId])
    if (ledgerError) throw new Error(ledgerError.message)
    nonGatewayRows = (ledgerRows ?? []).length

    projection = await getPaymentProjections(supabase, params.restaurantId, [params.orderId])
  } catch (e) {
    console.error('[checkPaidOrderCancellation] payment state unreadable', {
      orderId: params.orderId,
      error: e instanceof Error ? e.message : String(e),
    })
    return {
      allowed: false,
      status: 503,
      code: 'PAYMENT_STATE_UNREADABLE',
      error: 'Could not check whether this order has been paid. Nothing was changed — try again.',
      refundPath: null,
    }
  }

  const sale = projection.get(params.orderId) ?? null
  if (sale) {
    // A gateway sale fully refunded is the ONE way money leaves an order in FlashTap.
    if (sale.paymentStatus === 'refunded' && settledAllocations === 0 && nonGatewayRows === 0) {
      return { allowed: true, fullyRefunded: true }
    }
    return {
      allowed: false,
      status: 409,
      code: 'ORDER_PAID_REFUND_REQUIRED',
      error:
        (sale.paymentStatus === 'partially_refunded'
          ? 'Part of this card payment has been refunded, but not all of it. '
          : 'This order has a card payment against it. ') + REFUND_ON_TERMINAL,
      refundPath: 'terminal_card_refund',
    }
  }

  if (paid) {
    return {
      allowed: false,
      status: 409,
      code: 'ORDER_PAID_REFUND_REQUIRED',
      error: 'This order has been paid and cannot be cancelled. ' + NO_REFUND_IN_FLASHTAP,
      refundPath: 'none_in_flashtap',
    }
  }

  if (settledAllocations > 0 || nonGatewayRows > 0) {
    return {
      allowed: false,
      status: 409,
      code: 'ORDER_PARTIALLY_PAID_REFUND_REQUIRED',
      error:
        'Part of this order has already been paid for, so it cannot be cancelled. ' +
        NO_REFUND_IN_FLASHTAP,
      refundPath: 'none_in_flashtap',
    }
  }

  return { allowed: true, fullyRefunded: false }
}

/**
 * ================================================================================================
 * THE BATCH FORM, FOR THE AUTOMATIC CANCELLERS (Sprint 2026-09-29, team-lead follow-up)
 * ================================================================================================
 *
 * The stale-POS sweep, the hosted-checkout expiry and the terminal payment-failed path cancel
 * orders that are still `pending` (or another claimable state), so `payment_status = 'paid'` can
 * never stop them -- but a pending order can still carry money: a settled item allocation, a
 * non-gateway ledger row, or a gateway sale the device recorded while the order row never moved.
 * Cancelling it writes that money away as 'cancelled'.
 *
 * Returns the ids that carry ANY of that evidence (a gateway sale counts unless refunded in full),
 * or null when it could not be read -- which every caller treats as "cancel nothing this run".
 * Not scoped to a restaurant: the sweeps run across venues, and order ids are uuids.
 */
export async function findOrdersWithMoney(
  supabase: Supabase,
  orderIds: readonly string[],
): Promise<Set<string> | null> {
  const ids = [...new Set(orderIds.map(String).filter(Boolean))]
  const withMoney = new Set<string>()
  if (ids.length === 0) return withMoney
  const wanted = new Set(ids)
  const CHUNK = 200
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)

      const { data: allocations, error: allocError } = await supabase
        .from('order_line_allocations')
        .select('order_id, settled_at')
        .in('order_id', batch)
      if (allocError) throw new Error(allocError.message)
      for (const a of (allocations ?? []) as Array<{ order_id: unknown; settled_at: unknown }>) {
        if (a.settled_at != null) withMoney.add(String(a.order_id))
      }

      const { data: ledger, error: ledgerError } = await supabase
        .from('non_gateway_payment_events')
        .select('order_ids')
        .overlaps('order_ids', batch)
      if (ledgerError) throw new Error(ledgerError.message)
      for (const row of (ledger ?? []) as Array<{ order_ids: unknown }>) {
        for (const id of Array.isArray(row.order_ids) ? row.order_ids.map(String) : []) {
          if (wanted.has(id)) withMoney.add(id)
        }
      }

      const { data: sales, error: salesError } = await supabase
        .from('payment_events')
        .select('business_order_no, amount, order_ids')
        .eq('event_type', 'sale')
        .overlaps('order_ids', batch)
      if (salesError) throw new Error(salesError.message)
      const saleRows = (sales ?? []) as Array<{ business_order_no: unknown; amount: unknown; order_ids: unknown }>
      if (saleRows.length === 0) continue

      const origins = [...new Set(saleRows.map((s) => String(s.business_order_no ?? '')).filter(Boolean))]
      const { data: refunds, error: refundError } = await supabase
        .from('payment_events')
        .select('origin_business_order_no, amount')
        .eq('event_type', 'refund_succeeded')
        .in('origin_business_order_no', origins)
      if (refundError) throw new Error(refundError.message)
      const refunded = new Map<string, number>()
      for (const r of (refunds ?? []) as Array<{ origin_business_order_no: unknown; amount: unknown }>) {
        const key = String(r.origin_business_order_no ?? '')
        refunded.set(key, (refunded.get(key) ?? 0) + Math.round(Number(r.amount) * 100))
      }
      for (const s of saleRows) {
        const saleCents = Math.round(Number(s.amount) * 100)
        // Refunded in full: the money has gone back, and the sale no longer holds the order.
        if ((refunded.get(String(s.business_order_no ?? '')) ?? 0) >= saleCents && saleCents > 0) continue
        for (const id of Array.isArray(s.order_ids) ? s.order_ids.map(String) : []) {
          if (wanted.has(id)) withMoney.add(id)
        }
      }
    }
  } catch (e) {
    console.error('[findOrdersWithMoney] payment state unreadable; nothing will be cancelled', {
      orders: ids.length,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
  return withMoney
}
