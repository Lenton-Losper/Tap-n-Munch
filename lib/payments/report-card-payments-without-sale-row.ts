/**
 * #156 — detect a card payment that was taken and never reached the ledger.
 *
 * WHY THIS EXISTS, AND WHY IT IS SERVER-SIDE. The `payment_events` ledger all but stopped on
 * 2026-07-28 and nobody noticed for a month: 99.7% of August card payments (1018 of 1021) have no
 * SALE row. The only trace of each failure was a `console.error` inside `recordSaleEvent` — on a
 * terminal, in a restaurant, that nobody reads.
 *
 * CORRECTED 2026-08-27, measured against production. "Stopped" is the wrong word and it points the
 * investigation in the wrong direction. Since 2026-07-29 the writer has succeeded **3 times out of
 * 1,215 card payments — 0.25%** (FNB ChowNow on 20 and 25 August, Mingle on 3 August; a fourth row
 * on 26 August is a hand-written repair, not a device write, and must be excluded from any re-count).
 *
 * That rules out the entire class of cause we were implicitly hunting. A removed call site, a bad
 * base URL, a dropped auth header or a deleted route fails 100% of the time. Something that
 * succeeds 0.25% of the time is a race, a timeout, or a condition that is almost never met — so the
 * 28 July change wants re-reading for what made a reliable path CONDITIONAL, not for what removed it.
 *
 * THE LESSON THAT SHAPES THIS FILE: an instrument that reports to the device is not an instrument
 * for the operator. vc99 added a wiretap event to that failure path, and it is still not enough —
 * `recordWiretapEvent` writes to the device's native module and there is no wiretap table, so a
 * failure is now recorded where only someone holding the terminal can read it. Worse, the thing
 * being watched IS the device's ability to reach us: if the call fails because the device cannot
 * talk to the server, it cannot tell the server that it failed. **A reporter that shares a failure
 * mode with the thing it reports on is not a reporter.**
 *
 * So this asks the question from the other side, where the answer is always available: the server
 * knows it marked an order paid by card. A SALE row should follow within seconds. Nothing checked
 * that it did.
 *
 * IT WOULD HAVE FIRED ON 28 JULY, on the first day, at 101-a-day volume — and it needs no APK, no
 * device cooperation, and no new endpoint. It works precisely when the device has gone quiet,
 * which is the only condition under which it matters.
 *
 * DETECTION ONLY. It issues nothing but selects. It cannot write a ledger row, cancel an order or
 * alter a payment: a missing SALE row is a bookkeeping fact, and fabricating one would destroy the
 * very signal that says the writer is broken. Same principle as the negative-stock report.
 */

import { hasAllocatedOrderNumber } from '@/lib/orders/order-identity'

export const SALE_ROW_GRACE_MINUTES = 15

export type CardPaymentWithoutSaleRow = {
  orderId: string
  orderNumber: number | null
  restaurantName: string
  total: number
  paidAt: string
  businessOrderNo: string | null
}

export type SaleRowGapReport = {
  /** Card payments inside the window, old enough that a SALE row should have arrived. */
  scanned: number
  /** How many of those have no SALE row naming them. */
  missing: number
  /** missing / scanned, 0..1. The number that says whether the ledger is working AT ALL. */
  missingRatio: number
  worst: CardPaymentWithoutSaleRow[]
}

type SupabaseLike = { from: (t: string) => any }

/**
 * @param lookbackHours how far back to look. The default is deliberately short: this is a "is the
 *   ledger working RIGHT NOW" check, not a backfill audit. A long window would keep reporting the
 *   known July–August gap forever and train everyone to ignore it.
 */
export async function reportCardPaymentsWithoutSaleRow(
  supabase: SupabaseLike,
  options: { lookbackHours?: number; nowMs?: number } = {},
): Promise<SaleRowGapReport> {
  const nowMs = options.nowMs ?? Date.now()
  const lookbackHours = options.lookbackHours ?? 6
  const since = new Date(nowMs - lookbackHours * 60 * 60 * 1000).toISOString()
  // Anything paid more recently than this is still legitimately in flight.
  const until = new Date(nowMs - SALE_ROW_GRACE_MINUTES * 60 * 1000).toISOString()

  const { data: paidRows, error: paidError } = await supabase
    .from('orders')
    .select('id, order_number, total, paid_at, paycloud_merchant_order_no, restaurant_id, restaurants(name)')
    .eq('payment_status', 'paid')
    .not('restaurant_id', 'is', null) // stress fixtures carry a NULL restaurant_id and would poison the ratio
    .gte('paid_at', since)
    .lte('paid_at', until)
    .order('paid_at', { ascending: false })
    .limit(500)

  if (paidError) throw paidError
  const paid = (paidRows ?? []) as Array<Record<string, any>>

  // Card is the default when the column is absent -- the same convention the ledger itself uses.
  const cardPaid = paid.filter(
    (o) => String(o.payment_method ?? 'card').toLowerCase() === 'card',
  )
  if (cardPaid.length === 0) {
    return { scanned: 0, missing: 0, missingRatio: 0, worst: [] }
  }

  const { data: saleRows, error: saleError } = await supabase
    .from('payment_events')
    .select('order_ids')
    .eq('event_type', 'sale')
    .gte('created_at', since)
    .limit(1000)

  if (saleError) throw saleError

  const named = new Set<string>()
  for (const row of (saleRows ?? []) as Array<{ order_ids?: unknown }>) {
    for (const id of Array.isArray(row.order_ids) ? row.order_ids : []) {
      named.add(String(id))
    }
  }

  const missingRows = cardPaid.filter((o) => !named.has(String(o.id)))

  return {
    scanned: cardPaid.length,
    missing: missingRows.length,
    missingRatio: cardPaid.length === 0 ? 0 : missingRows.length / cardPaid.length,
    worst: missingRows.slice(0, 10).map((o) => ({
      orderId: String(o.id),
      // hasAllocatedOrderNumber, never `== null`: `0` is not a legal order number here and both
      // `!= null` and `typeof === 'number'` admit it. That is how "Order #0" reached production
      // three times, and the static gate caught this exact line in my own first draft.
      orderNumber: hasAllocatedOrderNumber(o) ? Number(o.order_number) : null,
      restaurantName: String(o.restaurants?.name ?? '(unknown)'),
      total: Number(o.total ?? 0),
      paidAt: String(o.paid_at),
      businessOrderNo: o.paycloud_merchant_order_no ? String(o.paycloud_merchant_order_no) : null,
    })),
  }
}
