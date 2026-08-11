import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** The two orders columns a merchant_order_no can legitimately match. */
const ORDER_REFERENCE_COLUMNS = ['paycloud_merchant_order_no', 'payment_reference'] as const

/**
 * Resolve order ids for a Finatic merchant_order_no.
 * 1) orders.paycloud_merchant_order_no OR orders.payment_reference (primary)
 * 2) payment_events.business_order_no → order_ids (fallback for older POS rows)
 *
 * THE DEFECT THIS CLOSES (#242) — unauthenticated cross-tenant filter injection.
 *
 * This function used to express the two-column match as ONE PostgREST `.or()`:
 *
 *     .or(`paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`)
 *
 * PostgREST PARSES the argument of `or=(...)`, and the comma is its term separator, so a
 * merchant_order_no containing one adds OR terms. `merchantOrderNo` arrives from the PayCloud
 * webhook BODY, and the route reaches this function on the path where signature verification
 * FAILED (app/api/webhooks/paycloud/route.ts) — so the value is unauthenticated, and the filter
 * carried no restaurant scope. Measured read-only on staging 2026-08-11:
 *
 *     benign   "NONEXISTENT-REF-ZZZZZZ"                ->   0 rows
 *     injected "NONEXISTENT-REF-ZZZZZZ,id.not.is.null" -> 213 rows, across 2 restaurants
 *
 * WHY REFORMULATE RATHER THAN VALIDATE. The sibling site (lib/guest-orders/validation.ts)
 * closes the identical defect with a charset allowlist, and doing the same here was the obvious
 * move. It was rejected deliberately, for two reasons:
 *
 *   1. This value can arrive as Finatic's `out_trade_no`, a field WE do not issue. Validating it
 *      against our own reference charset means a legitimate webhook carrying an unexpected
 *      character would fail CLOSED, answer 503 forever, and a real payment would never be
 *      applied. For a QR/hosted-checkout order that is unrecoverable — the webhook is the only
 *      confirmation path (the stale-POS sweeper is channel='pos' only, and reconcileOrphanPayments
 *      reads payment_events, which the QR leg never writes).
 *   2. mark-order-paid-confirmed.ts writes the raw webhook string into `payment_reference`, and
 *      this route backfills `paycloud_merchant_order_no` with it. Validating at the READ side
 *      while the WRITE side stores unvalidated gateway text manufactures values that exist in
 *      the table and can never be looked up again.
 *
 * `.eq()` needs neither. PostgREST's grammar for a column filter is `<column>=<operator>.<value>`:
 * we supply the column and the operator, and the whole remainder is ONE opaque value with no
 * position in which a second column name can appear. There is no parser, so there is nothing to
 * validate and no charset assumption to get wrong. Two `.eq()` queries unioned here are exactly
 * the OR they replace — verified on six real references, which returned identical id sets — and
 * 13 injection payloads that widened the `.or()` to the whole table return zero through this.
 *
 * The `payment_events` leg below was always `.eq()` and was never affected.
 */
export async function resolveOrderIdsByMerchantOrderNo(
  supabase: Supabase,
  merchantOrderNo: string,
): Promise<{ orderIds: string[]; source: 'orders' | 'payment_events' | null }> {
  const mo = merchantOrderNo.trim()
  if (!mo) return { orderIds: [], source: null }

  // Union in JS rather than in one parsed filter. Both columns are queried on every call, so the
  // result set does not depend on which one happens to be checked first.
  const orderIds = new Set<string>()
  for (const column of ORDER_REFERENCE_COLUMNS) {
    const { data: orderRows, error: orderError } = await supabase
      .from('orders')
      .select('id')
      .eq(column, mo)

    if (orderError) {
      throw new Error(`resolveOrderIdsByMerchantOrderNo orders: ${orderError.message}`)
    }

    for (const row of orderRows ?? []) {
      const id = String(row.id || '').trim()
      if (id) orderIds.add(id)
    }
  }

  if (orderIds.size > 0) {
    return {
      orderIds: [...orderIds],
      source: 'orders',
    }
  }

  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('order_ids')
    .eq('business_order_no', mo)
    .eq('event_type', 'sale')
    .limit(5)

  if (eventsError) {
    throw new Error(`resolveOrderIdsByMerchantOrderNo payment_events: ${eventsError.message}`)
  }

  const ids = new Set<string>()
  for (const event of events ?? []) {
    const raw = event.order_ids
    if (!Array.isArray(raw)) continue
    for (const id of raw) {
      const s = String(id || '').trim()
      if (s) ids.add(s)
    }
  }

  if (ids.size === 0) return { orderIds: [], source: null }
  return { orderIds: [...ids], source: 'payment_events' }
}
