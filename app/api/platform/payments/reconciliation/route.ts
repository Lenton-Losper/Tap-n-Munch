import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { excludeStressFixtures } from '@/lib/orders/stress-fixtures'
import {
  classifyOrder,
  summarise,
  type ReconciliationFinding,
  type ReconciliationLedgerRow,
  type ReconciliationOrder,
} from '@/lib/payments/reconciliation'

export const dynamic = 'force-dynamic'

/**
 * READ-ONLY PAYMENT RECONCILIATION.
 *
 * ==================================================================================================
 * WHAT IT ANSWERS
 * ==================================================================================================
 *
 *   "For every FlashTap card payment, what gateway transaction proves it?"
 *   "For every gateway transaction, where did this money go?"
 *
 * It joins the four places the evidence lives -- `orders`, `payment_events`,
 * `order_line_allocation_settlements` and the `payment.verification_uncertain` audit trail -- and
 * classifies every card order into one of the categories in lib/payments/reconciliation.ts.
 *
 * ==================================================================================================
 * IT HAS NO WRITER, AND THAT IS THE DESIGN
 * ==================================================================================================
 *
 * GET only. There is deliberately no POST, no "resolve" action and no sweep, because the one thing
 * that must never happen to an uncertain payment is an automatic decision: E04111 from this gateway
 * means NO RECORD, never NOT PAID, so auto-settling is a free meal and auto-failing takes a real
 * charge twice (ruling 2026-09-06, restated in F11). A human resolves these, from this list.
 *
 * ==================================================================================================
 * STRESS FIXTURES ARE EXCLUDED, AND THE REASON IS ARITHMETIC
 * ==================================================================================================
 *
 * 1,314 of production's orders are load-test debris. Leaving them in does not merely inflate a
 * count -- it makes the report unusable, because the genuine findings are a minority of the total
 * and a reader cannot tell which is which. The same exclusion every other production denominator
 * uses.
 */

/** Cap on rows examined per call, so an operator cannot accidentally scan the whole estate. */
const MAX_ORDERS = 2000

export async function GET(req: Request) {
  const admin = await resolvePlatformAdmin(req)
  if (admin instanceof NextResponse) return admin

  try {
    const supabase = createServerSupabaseClient()
    const url = new URL(req.url)

    const restaurantId = String(url.searchParams.get('restaurant_id') ?? '').trim()
    const since =
      String(url.searchParams.get('since') ?? '').trim() ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const onlyCategory = String(url.searchParams.get('category') ?? '').trim()
    const limit = Math.min(
      MAX_ORDERS,
      Math.max(1, Number(url.searchParams.get('limit') ?? MAX_ORDERS) || MAX_ORDERS),
    )

    let ordersQuery = supabase
      .from('orders')
      .select(
        'id, order_number, restaurant_id, payment_status, payment_method, total, paid_at, ' +
          'placed_at, paycloud_merchant_order_no, pending_charge_cents, ' +
          /**
           * `firebase_restaurant_id` is REQUIRED by the stress-fixture predicate, not decoration.
           * Without it `excludeStressFixtures` calls every row real, and production's `orders` is
           * 37% load-test debris (1,314 of 3,522 on 2026-08-27) -- so this report would have
           * counted that debris as genuine findings and quoted a critical total up to 37% too
           * high. Caught by scripts/check-orders-fixture-excluded.ts, whose message says exactly
           * this.
           */
          'firebase_restaurant_id',
      )
      .gte('placed_at', since)
      .order('placed_at', { ascending: false })
      .limit(limit)

    if (restaurantId) ordersQuery = ordersQuery.eq('restaurant_id', restaurantId)
    ordersQuery = excludeStressFixtures(ordersQuery)

    const { data: orderRows, error: ordersError } = await ordersQuery
    if (ordersError) {
      console.error('[platform/payments/reconciliation] order read failed', ordersError)
      return NextResponse.json({ error: 'Failed to read orders' }, { status: 500 })
    }

    const orders = (orderRows ?? []) as unknown as ReconciliationOrder[]
    const orderIds = orders.map((o) => String(o.id))

    if (orderIds.length === 0) {
      return NextResponse.json({
        since,
        restaurant_id: restaurantId || null,
        summary: summarise([]),
        findings: [],
      })
    }

    /**
     * THE LEDGER, BY ORDER. `payment_events.order_ids` is a uuid[] with a GIN index, so this is
     * one containment query rather than a join -- see the note on that column about why it stays
     * an array for now.
     */
    const { data: eventRows, error: eventsError } = await supabase
      .from('payment_events')
      .select('order_ids, business_order_no, transaction_id, amount, event_type, created_at')
      .overlaps('order_ids', orderIds)

    if (eventsError) {
      /**
       * FAILS LOUDLY. A reconciliation that cannot read the ledger would classify every card order
       * as `gateway_success_missing_ledger` and report a catastrophe that is not happening. An
       * unreadable input is a 503, never a finding.
       */
      console.error('[platform/payments/reconciliation] ledger read failed', eventsError)
      return NextResponse.json(
        { error: 'Could not read the payment ledger; the report would be wrong.' },
        { status: 503 },
      )
    }

    const ledgerByOrder = new Map<string, ReconciliationLedgerRow[]>()
    for (const row of (eventRows ?? []) as unknown as ReconciliationLedgerRow[]) {
      for (const id of (row.order_ids as string[]) ?? []) {
        const key = String(id)
        if (!ledgerByOrder.has(key)) ledgerByOrder.set(key, [])
        ledgerByOrder.get(key)!.push(row)
      }
    }

    /** Settled allocations, so a part-paid order is not reported as an unexplained gap. */
    const { data: allocRows, error: allocError } = await supabase
      .from('order_line_allocations')
      .select('order_id, amount_cents, settled_at, voided_at')
      .in('order_id', orderIds)
      .not('settled_at', 'is', null)

    if (allocError) {
      console.error('[platform/payments/reconciliation] allocation read failed', allocError)
      return NextResponse.json(
        { error: 'Could not read allocation settlements; the report would be wrong.' },
        { status: 503 },
      )
    }

    const allocatedByOrder = new Map<string, number>()
    for (const row of allocRows ?? []) {
      const r = row as { order_id: unknown; amount_cents: unknown; voided_at: unknown }
      if (r.voided_at) continue
      const key = String(r.order_id)
      allocatedByOrder.set(key, (allocatedByOrder.get(key) ?? 0) + (Number(r.amount_cents) || 0))
    }

    /**
     * Orders a gateway check could not resolve. `audit_logs.entity_id` is TEXT and holds the order
     * id, which is why this compares strings rather than uuids.
     */
    const { data: uncertainRows, error: uncertainError } = await supabase
      .from('audit_logs')
      .select('entity_id')
      .eq('action', 'payment.verification_uncertain')
      .in('entity_id', orderIds)

    if (uncertainError) {
      console.error('[platform/payments/reconciliation] audit read failed', uncertainError)
      return NextResponse.json(
        { error: 'Could not read the verification audit trail; the report would be wrong.' },
        { status: 503 },
      )
    }

    const uncertain = new Set(
      (uncertainRows ?? []).map((r) => String((r as { entity_id: unknown }).entity_id)),
    )

    const findings: ReconciliationFinding[] = orders.map((order) =>
      classifyOrder({
        order,
        ledgerRows: ledgerByOrder.get(String(order.id)) ?? [],
        allocatedCents: allocatedByOrder.get(String(order.id)) ?? 0,
        hasUnresolvedUncertainty: uncertain.has(String(order.id)),
      }),
    )

    /**
     * The summary is computed over EVERYTHING before any filtering, so narrowing to one category
     * cannot make the other categories appear to be zero. A filtered report that silently
     * redefines its own denominator is how an anomaly stops being visible.
     */
    const summary = summarise(findings)

    const visible = onlyCategory
      ? findings.filter((f) => f.category === onlyCategory)
      : // Unactionable rows are dropped from the LIST, never from the summary: an operator wants
        // the exceptions, and `matched` is most of the estate.
        findings.filter((f) => f.category !== 'matched')

    // Most severe first, then largest money first -- the order a human should work them in.
    const rank = { critical: 0, review: 1, ok: 2 } as const
    visible.sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] || b.orderAmountCents - a.orderAmountCents,
    )

    return NextResponse.json({
      since,
      restaurant_id: restaurantId || null,
      orders_examined: orders.length,
      // True when the cap was hit, so a reader knows the report is a window and not the estate.
      truncated: orders.length >= limit,
      summary,
      findings: visible,
    })
  } catch (err) {
    console.error('[platform/payments/reconciliation]', err)
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500 })
  }
}
