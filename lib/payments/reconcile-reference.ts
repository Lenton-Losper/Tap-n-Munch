/**
 * IS THIS GATEWAY REFERENCE THE ONE PREPARED FOR THESE ORDERS, AND HAS IT ALREADY BEEN USED?
 *
 * Shared by the two paths that turn a reference into a settlement AFTER the fact:
 *
 *   app/api/payments/reconcile/route.ts          staff pick orders AND a reference
 *   lib/payments/reconcile-orphan-payments.ts     the cron reads a device-reported payment_events row
 *
 * ==================================================================================================
 * THE DEFECT (Sprint 2026-09-29 brief, task 4)
 * ==================================================================================================
 *
 * The staff route took client-chosen `orderIds` AND a client-chosen `merchantOrderNo`, asked Finatic
 * about the reference, and if the gateway amount equalled the chosen orders' totals it marked them
 * paid. Nothing tied the reference to the orders. Any paid reference of the right amount -- another
 * table's, another venue's, one already applied -- paid any unpaid orders that happened to sum to it.
 * Once a reference is bound to the orders here, that is no longer possible.
 *
 * ==================================================================================================
 * THE RULES
 * ==================================================================================================
 *
 * BOUND, from server state only:
 *   - an intent (`terminal_payment_intents.merchant_order_no`) of THIS venue, scope `orders`, whose
 *     `order_ids` are exactly the requested set; or
 *   - orders carrying it as `paycloud_merchant_order_no` (prepare-payment minted it on the lead),
 *     all in THIS venue, whose settlement target (resolveSettlementTarget: the lead expanded through
 *     `pending_settlement_id`) is exactly the requested set.
 *   A reference neither of those knows about cannot be verified as prepared for anything, so it
 *   refuses. The route used to invent `${restaurantId}:${orderId}` when it had none. That fallback
 *   is gone.
 *
 * CONSUMED, by any payment already recorded:
 *   - the intent has `consumed_at`;
 *   - an order that is already PAID carries it (`paycloud_merchant_order_no` or `payment_reference`);
 *   - a SERVER-VERIFIED `payment_events` sale row carries it. A device-reported row does NOT consume
 *     it: that row is the unverified report this verification exists to check;
 *   - (after the gateway query) the gateway's transaction id is already on a ledger row for a
 *     different reference, or on a paid order.
 *
 * `.eq()` / `.in()` only -- never `.or()`. The reference is client input on the staff path, and a
 * parsed filter is the #242 injection.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { findIntentByMerchantOrderNo, type PaymentIntent } from '@/lib/payments/payment-intents'
import { resolveSettlementTarget, type SettlementTarget } from '@/lib/payments/settlement-target'
import { isPaidPaymentStatus } from '@/lib/payments/payment-integrity'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type ReferenceRefusalCode =
  /** No intent and no order carries this reference: it was never prepared for anything. */
  | 'REFERENCE_UNKNOWN'
  /** The reference belongs to another venue. */
  | 'REFERENCE_NOT_FOR_RESTAURANT'
  /** The reference was prepared for a different set of orders (or is a split-payment intent). */
  | 'REFERENCE_NOT_FOR_THESE_ORDERS'
  /** A payment has already been recorded against this reference or its gateway transaction. */
  | 'REFERENCE_ALREADY_CONSUMED'
  /** A read failed. Not knowing is not permission. */
  | 'REFERENCE_UNREADABLE'

export type BoundReference =
  | {
      ok: true
      intent: PaymentIntent | null
      /** What settleWholeOrderPayment is handed as leadOrderIds. */
      leadOrderIds: string[]
      target: SettlementTarget
    }
  | { ok: false; code: ReferenceRefusalCode; detail: string }

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map(String))
  const sb = new Set(b.map(String))
  if (sa.size !== sb.size) return false
  for (const v of sa) if (!sb.has(v)) return false
  return true
}

/**
 * Bind `merchantOrderNo` to exactly `orderIds` in `restaurantId`, from server state.
 */
export async function bindReferenceToOrders(
  supabase: Supabase,
  params: { restaurantId: string; merchantOrderNo: string; orderIds: readonly string[] },
): Promise<BoundReference> {
  const mo = params.merchantOrderNo.trim()
  const requested = [...new Set(params.orderIds.map(String))]
  if (!mo) return { ok: false, code: 'REFERENCE_UNKNOWN', detail: 'no reference' }

  let intent: PaymentIntent | null
  try {
    intent = await findIntentByMerchantOrderNo(supabase, mo)
  } catch (e) {
    return { ok: false, code: 'REFERENCE_UNREADABLE', detail: e instanceof Error ? e.message : String(e) }
  }

  let leadOrderIds: string[]
  if (intent) {
    if (intent.restaurantId !== params.restaurantId) {
      return { ok: false, code: 'REFERENCE_NOT_FOR_RESTAURANT', detail: `intent ${intent.id}` }
    }
    // An allocations intent pays for ITEMS, not orders; settling it as whole orders is the defect
    // that closed order #45. It is never a staff whole-order reconciliation.
    if (intent.scope !== 'orders') {
      return { ok: false, code: 'REFERENCE_NOT_FOR_THESE_ORDERS', detail: 'split-payment (allocations) intent' }
    }
    // The intent's order_ids ARE its target (resolveSettlementTarget, basis 'intent'), so the
    // set-equality check below is what refuses an intent prepared for different orders.
    leadOrderIds = intent.orderIds
  } else {
    // Unscoped by venue ON PURPOSE: a hit in another venue is a refusal, not an absence.
    const { data, error } = await supabase
      .from('orders')
      .select('id, restaurant_id')
      .eq('paycloud_merchant_order_no', mo)
      .limit(50)
    if (error) return { ok: false, code: 'REFERENCE_UNREADABLE', detail: error.message }
    const rows = (data ?? []) as Array<{ id: unknown; restaurant_id: unknown }>
    if (rows.length === 0) {
      return { ok: false, code: 'REFERENCE_UNKNOWN', detail: 'no intent or order carries this reference' }
    }
    if (rows.some((r) => String(r.restaurant_id) !== params.restaurantId)) {
      return { ok: false, code: 'REFERENCE_NOT_FOR_RESTAURANT', detail: 'reference is on another venue\'s order' }
    }
    leadOrderIds = rows.map((r) => String(r.id))
  }

  const resolved = await resolveSettlementTarget(supabase, {
    restaurantId: params.restaurantId,
    leadOrderIds,
    intent,
  })
  if (!resolved.ok) {
    return resolved.reason === 'cross_restaurant'
      ? { ok: false, code: 'REFERENCE_NOT_FOR_RESTAURANT', detail: resolved.reason }
      : { ok: false, code: 'REFERENCE_UNREADABLE', detail: resolved.reason }
  }
  // THE PREPARED SET MUST BE THE REQUESTED SET, in both directions. A subset is the Riviera shape;
  // a superset would pay orders nobody asked to reconcile.
  if (!sameSet(resolved.target.orderIds, requested)) {
    return {
      ok: false,
      code: 'REFERENCE_NOT_FOR_THESE_ORDERS',
      detail: `reference was prepared for [${[...resolved.target.orderIds].sort().join(',')}]`,
    }
  }
  return { ok: true, intent, leadOrderIds, target: resolved.target }
}

/**
 * A `payment_events` sale row the SERVER wrote after verifying the gateway (settle_order_payment's
 * ledger row, or any row tagged origin='gateway'). A device-reported row is not one: its amount and
 * order_ids are the device's word. Legacy rows carry no origin; the RPC's rows are recognisable by
 * `raw_gateway_response.recorded_by = 'server'`, which it has written since 20260919090000.
 */
export function isServerVerifiedLedgerRow(row: { origin?: unknown; raw_gateway_response?: unknown }): boolean {
  if (row.origin === 'gateway') return true
  if (row.origin === 'terminal_device') return false
  const raw = row.raw_gateway_response
  return Boolean(raw && typeof raw === 'object' && (raw as Record<string, unknown>).recorded_by === 'server')
}

export type Consumption =
  | { consumed: false }
  | { consumed: true; by: 'intent' | 'paid_order' | 'ledger_row' | 'transaction_id'; detail: string }
  | { consumed: null; detail: string }

/**
 * Has a payment already been recorded against this reference (and, when known, the gateway's
 * transaction id)? `consumed: null` means a read failed -- the caller refuses.
 */
export async function referenceConsumption(
  supabase: Supabase,
  params: {
    restaurantId: string
    merchantOrderNo: string
    intent: PaymentIntent | null
    transactionId?: string | null
  },
): Promise<Consumption> {
  const mo = params.merchantOrderNo.trim()

  if (params.intent) {
    const { data, error } = await supabase
      .from('terminal_payment_intents')
      .select('id, consumed_at, status')
      .eq('id', params.intent.id)
      .maybeSingle()
    if (error) return { consumed: null, detail: error.message }
    const row = (data ?? null) as { consumed_at?: unknown; status?: unknown } | null
    if (row?.consumed_at) return { consumed: true, by: 'intent', detail: `intent ${params.intent.id} consumed` }
  }

  for (const column of ['paycloud_merchant_order_no', 'payment_reference'] as const) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq(column, mo)
      .limit(50)
    if (error) return { consumed: null, detail: error.message }
    const paid = ((data ?? []) as Array<{ id: unknown; payment_status: unknown }>).find((r) =>
      isPaidPaymentStatus(r.payment_status),
    )
    if (paid) return { consumed: true, by: 'paid_order', detail: `order ${String(paid.id)} is paid on ${column}` }
  }

  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('id, restaurant_id, origin, raw_gateway_response')
    .eq('event_type', 'sale')
    .eq('business_order_no', mo)
    .limit(50)
  if (eventsError) return { consumed: null, detail: eventsError.message }
  const verified = ((events ?? []) as Array<Record<string, unknown>>).find(isServerVerifiedLedgerRow)
  if (verified) {
    return { consumed: true, by: 'ledger_row', detail: `payment_events ${String(verified.id)}` }
  }

  const txn = String(params.transactionId ?? '').trim()
  if (txn) {
    const { data: txnEvents, error: txnError } = await supabase
      .from('payment_events')
      .select('id, business_order_no')
      .eq('restaurant_id', params.restaurantId)
      .eq('transaction_id', txn)
      .limit(10)
    if (txnError) return { consumed: null, detail: txnError.message }
    const other = ((txnEvents ?? []) as Array<Record<string, unknown>>).find(
      (e) => String(e.business_order_no ?? '') !== mo,
    )
    if (other) {
      return { consumed: true, by: 'transaction_id', detail: `transaction ${txn} is on payment_events ${String(other.id)}` }
    }

    const { data: txnOrders, error: txnOrdersError } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('restaurant_id', params.restaurantId)
      .eq('paycloud_transaction_id', txn)
      .limit(10)
    if (txnOrdersError) return { consumed: null, detail: txnOrdersError.message }
    const paid = ((txnOrders ?? []) as Array<{ id: unknown; payment_status: unknown }>).find((r) =>
      isPaidPaymentStatus(r.payment_status),
    )
    if (paid) return { consumed: true, by: 'transaction_id', detail: `transaction ${txn} paid order ${String(paid.id)}` }
  }

  return { consumed: false }
}
