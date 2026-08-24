/**
 * WHY DO SO MANY PAID CARD ORDERS HAVE NO SALE EVENT? Production, READ ONLY.
 *
 * ============================================================================================
 * WHAT THE FIRST VERSION OF THIS PROBE GOT WRONG, because it matters more than the answer
 * ============================================================================================
 *
 * It partitioned paid orders by `audit_logs.action = 'order.paid'`. THAT ACTION HAS NEVER EXISTED.
 * markOrderPaidConfirmed writes `payment.completed`, hardcoded, with no exported constant -- so it
 * was guessable, and I guessed. The query returned zero rows across 1633 paid orders, every bucket
 * collapsed into "(no audit row)", and the output printed that as though it were a result. The
 * control collapsed too, which is what should have made it obvious.
 *
 * Two fixes, and the second is the durable one:
 *   1. the correct action names
 *   2. THE PROBE NOW REFUSES to partition when the coverage is too thin to divide the population.
 *      A partition over an empty map is not a result; it is a shape that reads like one.
 *
 * ============================================================================================
 * THE STRUCTURAL DISCRIMINATOR — works without any audit rows at all
 * ============================================================================================
 *
 * Only the DEVICE posts a sale event (`POST /api/terminal/payment-events/sale`; nothing server-side
 * calls it). So hosted-checkout, cash and reconcile-paid orders correctly have none, and a large
 * "no sale event" count is expected.
 *
 * What is NOT expected: `payment_channel = 'card_manual'` WITH a gateway reference.
 * `card_manual` is written by app/api/terminal/orders/route.ts (a POS order rung up ON the terminal)
 * and by the cart when a customer chooses to pay by card at the table. Both are settled at a card
 * reader, and a `paycloud_merchant_order_no` means a transaction was actually allocated. Those
 * should have a sale event.
 *
 * That set, not the raw total, is the duplicate-charge detector's real blind spot.
 */
import { guard, all } from './_guard'

type Order = {
  id: string
  order_number: number | null
  restaurant_id: string | null
  payment_status: string | null
  payment_method: string | null
  payment_channel: string | null
  channel: string | null
  paycloud_merchant_order_no: string | null
  payment_reference: string | null
  terminal_sn: string | null
  placed_at: string | null
  paid_at: string | null
}

/**
 * The real vocabulary, read from the source rather than assumed. markOrderPaidConfirmed writes
 * `payment.completed`; the reconcile path writes its own.
 */
const PAID_ACTIONS = ['payment.completed', 'payment.marked_paid_by_reconcile']

async function main() {
  const { db } = guard([
    'Reads orders, payment_events and audit_logs. Writes nothing.',
    'Establishes which paid orders SHOULD have a sale event and do not, using a',
    'discriminator that does not depend on audit rows existing.',
  ])

  const orders = await all<Order>((f, t) =>
    db
      .from('orders')
      .select(
        'id, order_number, restaurant_id, payment_status, payment_method, payment_channel, channel, paycloud_merchant_order_no, payment_reference, terminal_sn, placed_at, paid_at',
      )
      .eq('payment_status', 'paid')
      .range(f, t),
  )
  console.log(`paid orders: ${orders.length}`)

  const events = await all<{ order_ids: string[] | null; app_version: string | null; created_at: string }>((f, t) =>
    db.from('payment_events').select('order_ids, app_version, created_at').eq('event_type', 'sale').range(f, t),
  )
  const withSale = new Set<string>()
  for (const e of events) for (const oid of e.order_ids ?? []) withSale.add(String(oid))
  console.log(`sale events: ${events.length}, naming ${withSale.size} distinct order(s)`)

  const rests = await all<{ id: string; name: string }>((f, t) => db.from('restaurants').select('id, name').range(f, t))
  const nameOf = new Map(rests.map((r) => [String(r.id), String(r.name)]))

  const paidAudits = await all<{ entity_id: string; metadata: Record<string, unknown> | null }>((f, t) =>
    db.from('audit_logs').select('entity_id, metadata').in('action', PAID_ACTIONS).range(f, t),
  )
  const paidSource = new Map<string, string>()
  for (const a of paidAudits) {
    const src = String(a.metadata?.source ?? '')
    if (src) paidSource.set(String(a.entity_id), src)
  }

  const attemptAudits = await all<{ entity_id: string; metadata: Record<string, unknown> | null }>((f, t) =>
    db.from('audit_logs').select('entity_id, metadata').eq('action', 'payment.attempt_started').range(f, t),
  )
  const attemptVersion = new Map<string, string>()
  for (const a of attemptAudits) {
    const v = String(a.metadata?.appVersion ?? '')
    if (v && v !== 'null' && v !== 'undefined') attemptVersion.set(String(a.entity_id), v)
  }

  console.log(`paid-path audit rows (${PAID_ACTIONS.join(' / ')}): ${paidAudits.length}`)
  console.log(`payment.attempt_started rows: ${attemptAudits.length}, ${attemptVersion.size} carrying an appVersion`)

  const covered = orders.filter((o) => paidSource.has(String(o.id))).length
  const ratio = orders.length === 0 ? 0 : covered / orders.length
  console.log(`  paid-path coverage: ${covered} of ${orders.length} (${(ratio * 100).toFixed(1)}%)`)

  const bucket = (rows: Order[], key: (o: Order) => string) => {
    const m: Record<string, number> = {}
    for (const o of rows) {
      const k = key(o)
      m[k] = (m[k] ?? 0) + 1
    }
    return Object.entries(m).sort(([, a], [, b]) => b - a)
  }
  const show = (rows: [string, number][]) => {
    for (const [k, n] of rows) console.log('  ' + String(n).padStart(5) + '  ' + k)
  }

  const missing = orders.filter((o) => !withSale.has(String(o.id)))
  console.log('')
  console.log('='.repeat(78))
  console.log(`PAID ORDERS WITH NO SALE EVENT: ${missing.length} of ${orders.length}`)
  console.log('='.repeat(78))
  console.log('\nby payment_channel:')
  show(bucket(missing, (o) => String(o.payment_channel ?? '(null)')))
  console.log('\nby channel:')
  show(bucket(missing, (o) => String(o.channel ?? '(null)')))
  console.log('\nby payment_method:')
  show(bucket(missing, (o) => String(o.payment_method ?? '(null)')))
  console.log('\nhas a gateway reference?')
  show(bucket(missing, (o) => (o.paycloud_merchant_order_no ? 'yes' : 'no')))

  // ---------------------------------------------------------------- the structural answer
  const terminalShaped = missing.filter(
    (o) => String(o.payment_channel ?? '') === 'card_manual' && Boolean(o.paycloud_merchant_order_no),
  )
  const terminalShapedCovered = orders.filter(
    (o) =>
      withSale.has(String(o.id)) &&
      String(o.payment_channel ?? '') === 'card_manual' &&
      Boolean(o.paycloud_merchant_order_no),
  )
  const denom = terminalShaped.length + terminalShapedCovered.length

  console.log('')
  console.log('='.repeat(78))
  console.log(`TERMINAL-SHAPED YET NO SALE EVENT: ${terminalShaped.length}`)
  console.log('='.repeat(78))
  console.log('  card_manual AND carrying a gateway reference: a card reader settled these, so a')
  console.log('  sale event was expected and is absent. THIS is the duplicate-charge blind spot.')
  console.log(`\n  CONTROL — same shape, sale event PRESENT: ${terminalShapedCovered.length}`)
  console.log(
    `  sale events cover ${denom === 0 ? 'n/a' : ((terminalShapedCovered.length / denom) * 100).toFixed(1) + '%'} of terminal-shaped paid orders`,
  )
  console.log('\n  by app version (from payment.attempt_started):')
  show(bucket(terminalShaped, (o) => attemptVersion.get(String(o.id)) ?? '(no version recorded)'))
  console.log('\n  by venue:')
  show(bucket(terminalShaped, (o) => nameOf.get(String(o.restaurant_id)) ?? String(o.restaurant_id)))
  console.log('\n  by month — a clean cut-off means it STOPPED; a smear means it never worked:')
  show(
    bucket(terminalShaped, (o) => String(o.paid_at ?? o.placed_at ?? '').slice(0, 7) || '(no date)').sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  )

  // ---------------------------------------------------------------- the audit partition, if usable
  console.log('')
  console.log('='.repeat(78))
  if (ratio < 0.2) {
    console.log('REFUSING TO PARTITION BY PAYING PATH — audit coverage too thin')
    console.log('='.repeat(78))
    console.log(`  Only ${(ratio * 100).toFixed(1)}% of paid orders carry a paid-path audit row, so a breakdown by`)
    console.log('  `source` would put nearly everything in one unknown bucket and read as a result.')
    console.log('')
    console.log('  THAT IS ITSELF A FINDING. Either these rows predate markOrderPaidConfirmed, or the')
    console.log('  audit insert has been failing: it logs on error and does NOT throw, by design,')
    console.log('  because the money has already moved -- so a systematic failure is invisible.')
    console.log('  Compare the oldest payment.completed row against the oldest paid order to tell')
    console.log('  those apart.')
  } else {
    console.log('BY THE CODE PATH THAT PAID THEM (audit metadata.source)')
    console.log('='.repeat(78))
    console.log('\n  with no sale event:')
    show(bucket(missing, (o) => paidSource.get(String(o.id)) ?? '(no audit row)'))
    console.log('\n  CONTROL — with a sale event:')
    show(bucket(orders.filter((o) => withSale.has(String(o.id))), (o) => paidSource.get(String(o.id)) ?? '(no audit row)'))
    console.log('\n  Only `terminal_callback` with no sale event is anomalous; the rest never post one.')
  }

  console.log('\nPROBE_SALE_EVENT_GAP_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
