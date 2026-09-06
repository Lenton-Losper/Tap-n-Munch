import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { findIntentByMerchantOrderNo, type PaymentIntent } from '@/lib/payments/payment-intents'

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
export type ResolvedReference = {
  orderIds: string[]
  source: 'intent' | 'orders' | 'payment_events' | null
  /**
   * WHAT THIS MONEY PAYS FOR, when the reference is an intent.
   *
   * Absent for every reference minted before intents existed, which is every reference on
   * production today. A caller that ignores this field behaves exactly as it did before — see the
   * note on the intent leg below.
   */
  intent?: PaymentIntent | null
}

export async function resolveOrderIdsByMerchantOrderNo(
  supabase: Supabase,
  merchantOrderNo: string,
): Promise<ResolvedReference> {
  const mo = merchantOrderNo.trim()
  if (!mo) return { orderIds: [], source: null }

  /**
   * ============================================================================================
   * LEG 0 — THE INTENT. Checked FIRST, and it is the only leg that can say "allocations".
   * ============================================================================================
   *
   * A split card payment mints its own reference (terminal_payment_intents) rather than reusing
   * the order's, because `orders.paycloud_merchant_order_no` is one value per ORDER and a second
   * charge against the same order would be indistinguishable from the first.
   *
   * WHY IT MUST BE FIRST, AND WHY THAT CHANGES NOTHING FOR EXISTING REFERENCES. An intent's
   * merchant_order_no is freshly minted and unique, so it can never be a value the two legs below
   * would also match. Every reference that resolves today therefore misses this leg entirely and
   * reaches exactly the code it reaches now, with exactly the same result. Nothing is backfilled
   * into that table — the six production orders carrying an old merchant_order_no (Digi Cofee #18
   * pending, #19/#28/#29/#39 cancelled, #40 paid) still resolve through `orders` below.
   *
   * THE CALLER MUST FORK ON `scope`. An allocations intent returns the orders its allocations sit
   * on, so a caller that only reads `orderIds` still sees something sane — but marking those
   * orders paid would close orders three quarters of which nobody has paid for. The webhook forks;
   * see app/api/webhooks/paycloud/route.ts.
   */
  const intent = await findIntentByMerchantOrderNo(supabase, mo)
  if (intent) {
    if (intent.scope === 'orders') {
      return { orderIds: intent.orderIds, source: 'intent', intent }
    }
    const orderIds = await orderIdsForAllocations(supabase, intent)
    return { orderIds, source: 'intent', intent }
  }

  // Union in JS rather than in one parsed filter. Both columns are queried on every call, so the
  // result set does not depend on which one happens to be checked first.
  const orderIds = new Set<string>()
  for (const column of ORDER_REFERENCE_COLUMNS) {
    // Narrow by construction -- a payment reference matches one order -- but routed through the
    // helper anyway. A read that returns one row costs exactly one request either way, and the
    // invariant "every read of orders goes through fetchAllRows or an explicit range" is worth
    // more than the exception, because an exception list is where the next real one hides.
    const orderRows = await fetchAllRows<{ id: string }>(
      supabase.from('orders').select('id').eq(column, mo),
      // The label names the TABLE, matching the payment_events leg below, which throws
      // `resolveOrderIdsByMerchantOrderNo payment_events: ...`. #323 moved this leg onto
      // fetchAllRows and dropped the segment, so the two legs stopped identifying themselves
      // the same way and a thrown error no longer said which read failed.
      { label: 'resolveOrderIdsByMerchantOrderNo orders' },
    )

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

/**
 * The orders an allocations intent touches, so a caller has somewhere to look even though it must
 * settle the ALLOCATIONS rather than the orders.
 *
 * Read through the allocations themselves rather than stored on the intent: an allocation's order
 * is a property of the allocation, and duplicating it would create a second place for it to be
 * wrong.
 */
async function orderIdsForAllocations(
  supabase: Supabase,
  intent: PaymentIntent,
): Promise<string[]> {
  if (intent.allocationIds.length === 0) return []

  /**
   * PostgREST types an embedded row as an ARRAY even on a to-one relationship, and returns it as
   * an object at runtime. Both shapes are handled rather than asserted away — getGratuityReport
   * carries the same note for the same reason.
   */
  type AllocationRow = {
    order_line_id: string
    order_lines: { order_id: string } | Array<{ order_id: string }> | null
  }

  const rows = await fetchAllRows<AllocationRow>(
    supabase
      .from('order_line_allocations')
      .select('order_line_id, order_lines!inner(order_id)')
      .in('id', intent.allocationIds) as never,
    { label: 'resolveOrderIdsByMerchantOrderNo allocations' },
  )

  const ids = new Set<string>()
  for (const row of rows ?? []) {
    const embedded = row.order_lines
    const orderId = Array.isArray(embedded)
      ? String(embedded[0]?.order_id ?? '').trim()
      : String(embedded?.order_id ?? '').trim()
    if (orderId) ids.add(orderId)
  }
  return [...ids]
}
