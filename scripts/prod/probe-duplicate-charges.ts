/**
 * HAS A DOUBLE CHARGE ALREADY HAPPENED? Production, READ ONLY.
 *
 * Run this FIRST. It bears directly on how fast the terminal APK has to ship.
 *
 * The server cannot prevent a second card charge — the reader transacts on the device before our
 * server is involved, and a second success callback for an already-paid order is answered 409
 * ALREADY_PAID *after the money has already moved*. That 409 branch returns before writing any audit
 * row, so a second charge leaves nothing in audit_logs.
 *
 * The ONE place it does leave a trace: payment_events is keyed `idempotency_key = business_order_no`,
 * which is per gateway transaction. A genuine second charge carries a new business_order_no, so it
 * inserts a SECOND `sale` row naming the same order id.
 *
 * Nothing in the system detects that today. This is that detector.
 *
 *
 * NOTE 2026-08-24: the two signals this looks for are now also implemented as a reusable
 * detector, lib/payments/detect-duplicate-charges.ts, so a scheduled check and this one-off
 * cannot drift apart in what they consider a duplicate. This script stays because it prints the
 * full working -- every event, both references, the blind-spot count -- which is what you want
 * the first time you look, and the library returns a list, which is what you want on a schedule.
 * It reports three things, and they are different questions:
 *   1. orders named by more than one `sale` event      -> a probable second charge
 *   2. sale events whose amount exceeds the order total -> a charge that does not match the sale
 *   3. orders paid but with NO sale event               -> the reverse blind spot, for context
 */
import { guard, all } from './_guard'

async function main() {
  const { db } = guard([
    'Reads payment_events and orders. Writes nothing.',
    'Looks for orders named by more than one sale event, which is the only trace a',
    'second card charge leaves anywhere in the system.',
  ])

  const events = await all<{
    id: string
    order_ids: string[] | null
    event_type: string
    business_order_no: string | null
    transaction_id: string | null
    amount: number | null
    created_at: string
    terminal_id: string | null
    app_version: string | null
  }>((f, t) =>
    db
      .from('payment_events')
      .select('id, order_ids, event_type, business_order_no, transaction_id, amount, created_at, terminal_id, app_version')
      .range(f, t),
  )
  console.log(`payment_events rows: ${events.length}`)

  const sales = events.filter((e) => String(e.event_type) === 'sale')
  console.log(`  of which sale: ${sales.length}`)

  // ---------------------------------------------------------------- 1. two sale events, one order
  const byOrder = new Map<string, typeof sales>()
  for (const e of sales) {
    for (const oid of e.order_ids ?? []) {
      const key = String(oid)
      if (!byOrder.has(key)) byOrder.set(key, [])
      byOrder.get(key)!.push(e)
    }
  }

  const multi = [...byOrder.entries()].filter(([, evs]) => {
    // Distinct gateway transactions only. The same transaction re-posted is deduped by the route's
    // idempotency key and is not a second charge.
    const refs = new Set(evs.map((e) => String(e.business_order_no ?? e.transaction_id ?? e.id)))
    return refs.size > 1
  })

  console.log('')
  console.log('='.repeat(78))
  console.log(`1. ORDERS WITH MORE THAN ONE DISTINCT SALE TRANSACTION: ${multi.length}`)
  console.log('='.repeat(78))
  if (multi.length === 0) {
    console.log('  none — no evidence any order was charged twice through the terminal')
  }
  for (const [orderId, evs] of multi) {
    const { data: o } = await db
      .from('orders')
      .select('order_number, total, payment_status, restaurant_id, placed_at')
      .eq('id', orderId)
      .maybeSingle()
    const row = (o ?? null) as unknown as { order_number?: number; total?: number; payment_status?: string; placed_at?: string } | null
    const charged = evs.reduce((s, e) => s + Number(e.amount ?? 0), 0)
    console.log('')
    console.log(`  order #${row?.order_number ?? '?'}  total ${row?.total ?? '?'}  status ${row?.payment_status ?? '?'}`)
    console.log(`    placed ${String(row?.placed_at ?? '').slice(0, 19)}   CHARGED IN TOTAL: ${charged}`)
    for (const e of evs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
      console.log(
        `      ${String(e.created_at).slice(0, 19)}  amount ${e.amount}  bno ${e.business_order_no ?? '-'}` +
          `  txn ${e.transaction_id ?? '-'}  app ${e.app_version ?? '-'}  terminal ${String(e.terminal_id ?? '-').slice(0, 8)}`,
      )
    }
  }

  // ---------------------------------------------------------------- 2. charged more than the order
  console.log('')
  console.log('='.repeat(78))
  console.log('2. SALE EVENTS CHARGING MORE THAN THE ORDER TOTAL')
  console.log('='.repeat(78))
  let overcharged = 0
  for (const [orderId, evs] of byOrder) {
    if (evs.length !== 1) continue
    const e = evs[0]
    if (e.amount == null) continue
    // A multi-order settle legitimately charges the sum of several orders, so only single-order
    // events can be compared to one total. Saying so matters: the comparison is invalid otherwise.
    if ((e.order_ids ?? []).length !== 1) continue
    const { data: o } = await db.from('orders').select('order_number, total').eq('id', orderId).maybeSingle()
    const total = Number((o as unknown as { total?: number } | null)?.total ?? NaN)
    if (!Number.isFinite(total)) continue
    if (Number(e.amount) > total + 0.01) {
      overcharged++
      console.log(
        `  order #${(o as unknown as { order_number?: number }).order_number}  total ${total}  charged ${e.amount}  bno ${e.business_order_no ?? '-'}`,
      )
    }
  }
  if (overcharged === 0) console.log('  none')

  // ---------------------------------------------------------------- 3. the reverse blind spot
  const paid = await all<{ id: string; order_number: number; payment_channel: string | null; paycloud_merchant_order_no: string | null }>((f, t) =>
    db
      .from('orders')
      .select('id, order_number, payment_channel, paycloud_merchant_order_no')
      .eq('payment_status', 'paid')
      .range(f, t),
  )
  // NARROWED 2026-08-24. This used to include `payment_channel == null`, which swept in every
  // order that was never a terminal card sale -- cash, hosted checkout, legacy rows -- and
  // reported 1144 of 1633 as a blind spot. That number was an artefact of the filter.
  //
  // A sale event is expected only where a card reader settled the order: `card_manual` (written
  // by the terminal POS route and by the cart's pay-by-card choice) WITH a gateway reference.
  // scripts/prod/probe-sale-event-gap.ts partitions this properly.
  const posPaid = paid.filter(
    (o) => String(o.payment_channel ?? '') === 'card_manual' && Boolean(o.paycloud_merchant_order_no),
  )
  const withoutEvent = posPaid.filter((o) => !byOrder.has(String(o.id)))
  console.log('')
  console.log('='.repeat(78))
  console.log('3. THE BLIND SPOT — TERMINAL-SETTLED orders with NO sale event')
  console.log('='.repeat(78))
  console.log(`  ${withoutEvent.length} of ${posPaid.length}`)
  console.log('  card_manual WITH a gateway reference, so a reader settled it and a sale event was')
  console.log('  expected. If a device does not post them, check 1 cannot see ITS double charges.')
  console.log('  A high number here weakens check 1 in direct proportion.')

  console.log('')
  console.log('PROBE_DUPLICATE_CHARGES_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
