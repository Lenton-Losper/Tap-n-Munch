import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { SECOND_PAYMENT_REFUSED_ACTION } from '@/lib/payments/record-refused-second-payment'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * CAN A DUPLICATE CHARGE BE DETECTED AFTER THE FACT? Yes — from two independent signals, and it is
 * worth having both because each is blind where the other sees.
 *
 * SIGNAL A — two payment_events `sale` rows naming one order, with different gateway references.
 *   `payment_events.idempotency_key` is `business_order_no`, which is per gateway TRANSACTION. A
 *   repeated callback for one transaction is deduped by that key; a genuinely second transaction
 *   carries a new number and inserts a new row. So two distinct references naming one order is a
 *   second charge.
 *   BLIND WHEN: the device never posts the sale event. Older builds may not.
 *
 * SIGNAL B — an `payment.refused_already_paid` audit row with `distinctGatewayTransaction: true`.
 *   Written by the payment route from 2026-08-24 at the exact moment it refuses a second success
 *   callback. Requires no cooperation beyond the device reaching our server at all.
 *   BLIND WHEN: the second charge never produced a callback to us, or predates 2026-08-24.
 *
 * Neither is a guarantee. A card charged on a device that then loses connectivity entirely leaves NO
 * trace in this system, and no query can find what was never sent. That limit is stated because a
 * clean result here must not be read as "no double charges happened".
 *
 * The output is deliberately a list of ORDERS, not a count: every hit is a customer who may need a
 * refund, and the reason `duplicate_charge` already exists on the refund route for exactly this.
 */

export type DuplicateChargeHit = {
  orderId: string
  orderNumber: number | null
  restaurantId: string
  orderTotal: number | null
  /** Which signal saw it. Both is stronger evidence, and one-signal hits are worth knowing apart. */
  signals: ('payment_events' | 'refused_callback')[]
  /** Distinct gateway references seen against this one order. */
  references: string[]
  /** Summed amount across the distinct sale events, when payment_events saw it. */
  chargedTotal: number | null
  firstSeenAt: string | null
  lastSeenAt: string | null
}

export type DuplicateChargeReport = {
  hits: DuplicateChargeHit[]
  saleEventsScanned: number
  refusalRowsScanned: number
  /** Paid card orders with no sale event at all — the measure of how blind signal A is here. */
  paidCardOrdersWithoutSaleEvent: number
}

async function page<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

export async function detectDuplicateCharges(supabase: Supabase): Promise<DuplicateChargeReport> {
  const events = await page<{
    id: string
    order_ids: string[] | null
    event_type: string
    business_order_no: string | null
    transaction_id: string | null
    amount: number | null
    created_at: string
  }>((f, t) =>
    supabase
      .from('payment_events')
      .select('id, order_ids, event_type, business_order_no, transaction_id, amount, created_at')
      .eq('event_type', 'sale')
      .range(f, t),
  )

  const byOrder = new Map<string, typeof events>()
  for (const e of events) {
    for (const oid of e.order_ids ?? []) {
      const k = String(oid)
      if (!byOrder.has(k)) byOrder.set(k, [])
      byOrder.get(k)!.push(e)
    }
  }

  const hits = new Map<string, DuplicateChargeHit>()

  // ---------------------------------------------------------------- signal A
  for (const [orderId, evs] of byOrder) {
    const refs = [...new Set(evs.map((e) => String(e.business_order_no ?? e.transaction_id ?? e.id)))]
    if (refs.length < 2) continue
    const times = evs.map((e) => String(e.created_at)).sort()
    hits.set(orderId, {
      orderId,
      orderNumber: null,
      restaurantId: '',
      orderTotal: null,
      signals: ['payment_events'],
      references: refs,
      chargedTotal: evs.reduce((s, e) => s + Number(e.amount ?? 0), 0),
      firstSeenAt: times[0] ?? null,
      lastSeenAt: times[times.length - 1] ?? null,
    })
  }

  // ---------------------------------------------------------------- signal B
  const refusals = await page<{
    entity_id: string
    restaurant_id: string
    created_at: string
    metadata: Record<string, unknown> | null
  }>((f, t) =>
    supabase
      .from('audit_logs')
      .select('entity_id, restaurant_id, created_at, metadata')
      .eq('action', SECOND_PAYMENT_REFUSED_ACTION)
      .range(f, t),
  )

  for (const r of refusals) {
    if (r.metadata?.distinctGatewayTransaction !== true) continue
    const orderId = String(r.entity_id)
    const attempted = String(r.metadata?.attemptedBusinessOrderNo ?? r.metadata?.attemptedReference ?? '')
    const existing = String(r.metadata?.existingBusinessOrderNo ?? r.metadata?.existingReference ?? '')
    const existingHit = hits.get(orderId)
    if (existingHit) {
      if (!existingHit.signals.includes('refused_callback')) existingHit.signals.push('refused_callback')
      for (const ref of [attempted, existing]) {
        if (ref && !existingHit.references.includes(ref)) existingHit.references.push(ref)
      }
      existingHit.restaurantId ||= String(r.restaurant_id)
      continue
    }
    hits.set(orderId, {
      orderId,
      orderNumber: null,
      restaurantId: String(r.restaurant_id),
      orderTotal: Number(r.metadata?.orderTotal ?? 0) || null,
      signals: ['refused_callback'],
      references: [attempted, existing].filter(Boolean),
      chargedTotal: null,
      firstSeenAt: String(r.created_at),
      lastSeenAt: String(r.created_at),
    })
  }

  // Fill in the order detail, so a hit is actionable without a second lookup.
  for (const hit of hits.values()) {
    const { data } = await supabase
      .from('orders')
      .select('order_number, total, restaurant_id')
      .eq('id', hit.orderId)
      .maybeSingle()
    const row = (data ?? null) as unknown as { order_number?: number; total?: number; restaurant_id?: string } | null
    if (row) {
      hit.orderNumber = row.order_number ?? null
      hit.orderTotal = hit.orderTotal ?? row.total ?? null
      hit.restaurantId ||= String(row.restaurant_id ?? '')
    }
  }

  // How blind is signal A here? A high number means check A cannot see much.
  const paidCard = await page<{ id: string; payment_channel: string | null }>((f, t) =>
    supabase.from('orders').select('id, payment_channel').eq('payment_status', 'paid').range(f, t),
  )
  const paidCardOrdersWithoutSaleEvent = paidCard.filter(
    (o) => !byOrder.has(String(o.id)) && (o.payment_channel == null || String(o.payment_channel).includes('card')),
  ).length

  return {
    hits: [...hits.values()].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))),
    saleEventsScanned: events.length,
    refusalRowsScanned: refusals.length,
    paidCardOrdersWithoutSaleEvent,
  }
}
