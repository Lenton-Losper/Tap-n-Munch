/**
 * WHY DO 1144 OF 1633 PAID CARD ORDERS HAVE NO SALE EVENT? Production, READ ONLY.
 *
 * ============================================================================================
 * FIRST: MY OWN FILTER IS A SUSPECT, AND IT SHOULD BE RULED OUT BEFORE THE FLEET IS
 * ============================================================================================
 *
 * probe-duplicate-charges.ts counted "paid card orders" as
 *
 *     payment_status = 'paid' AND (payment_channel IS NULL OR payment_channel LIKE '%card%')
 *
 * `payment_channel IS NULL` sweeps in every order that was never a terminal card sale at all --
 * cash settlements, legacy rows, and anything created before that column was populated. ONLY THE
 * TERMINAL DEVICE POSTS A SALE EVENT (`POST /api/terminal/payment-events/sale`; nothing server-side
 * calls it), so an order paid by hosted checkout, by cash at the till, or by the reconcile cron
 * CORRECTLY has none.
 *
 * So a large "no sale event" count is expected and mostly benign. The number that matters is
 * narrower: orders THE TERMINAL ITSELF PAID that still have no sale event.
 *
 * ============================================================================================
 * THE DISCRIMINATOR THAT ACTUALLY ANSWERS IT
 * ============================================================================================
 *
 * markOrderPaidConfirmed writes an audit row carrying `source`, which names the code path that
 * marked the order paid:
 *
 *     terminal_callback              the device called us -> A SALE EVENT IS EXPECTED
 *     paycloud webhook / reconcile   hosted checkout or a cron  -> none expected
 *     terminal_verify_payment        a Finatic re-check         -> none expected
 *
 * That turns "why is it missing" from a guess into a partition.
 *
 * AND THE VERSION IS RECOVERABLE, despite the obvious circularity. The app version at the time of
 * sale is recorded on payment_events.app_version -- the row that is missing. But
 * `payment.attempt_started` audit rows ALSO carry `appVersion`, written by mark-payment-attempt-
 * started when the push begins, and those survive. restaurant_terminals.app_version is NOT usable
 * for this: it is the CURRENT version of a device that may have updated since.
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

async function main() {
  const { db } = guard([
    'Reads orders, payment_events and audit_logs. Writes nothing.',
    'Partitions the paid orders that have no sale event by the code path that PAID',
    'them, and correlates the terminal-paid ones with the app version recorded on',
    'their payment.attempt_started audit row.',
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

  const events = await all<{ order_ids: string[] | null; event_type: string; app_version: string | null; created_at: string }>(
    (f, t) => db.from('payment_events').select('order_ids, event_type, app_version, created_at').eq('event_type', 'sale').range(f, t),
  )
  const withSale = new Set<string>()
  for (const e of events) for (const oid of e.order_ids ?? []) withSale.add(String(oid))
  console.log(`sale events: ${events.length}, naming ${withSale.size} distinct order(s)`)

  const rests = await all<{ id: string; name: string }>((f, t) => db.from('restaurants').select('id, name').range(f, t))
  const nameOf = new Map(rests.map((r) => [String(r.id), String(r.name)]))

  // ---------------------------------------------------------------- how the order was PAID
  const paidAudits = await all<{ entity_id: string; metadata: Record<string, unknown> | null; created_at: string }>((f, t) =>
    db.from('audit_logs').select('entity_id, metadata, created_at').eq('action', 'order.paid').range(f, t),
  )
  const paidSource = new Map<string, string>()
  for (const a of paidAudits) {
    const src = String(a.metadata?.source ?? '')
    if (src) paidSource.set(String(a.entity_id), src)
  }
  console.log(`order.paid audit rows: ${paidAudits.length}`)

  const attemptAudits = await all<{ entity_id: string; metadata: Record<string, unknown> | null }>((f, t) =>
    db.from('audit_logs').select('entity_id, metadata').eq('action', 'payment.attempt_started').range(f, t),
  )
  const attemptVersion = new Map<string, string>()
  for (const a of attemptAudits) {
    const v = String(a.metadata?.appVersion ?? '')
    if (v && v !== 'null') attemptVersion.set(String(a.entity_id), v)
  }
  console.log(`payment.attempt_started audit rows: ${attemptAudits.length}, ${attemptVersion.size} carrying an appVersion`)

  const missing = orders.filter((o) => !withSale.has(String(o.id)))
  console.log('')
  console.log('='.repeat(78))
  console.log(`PAID ORDERS WITH NO SALE EVENT: ${missing.length} of ${orders.length}`)
  console.log('='.repeat(78))

  const bucket = (rows: Order[], key: (o: Order) => string) => {
    const m: Record<string, number> = {}
    for (const o of rows) {
      const k = key(o)
      m[k] = (m[k] ?? 0) + 1
    }
    return Object.entries(m).sort(([, a], [, b]) => b - a)
  }

  console.log('\nby the code path that PAID them (order.paid audit metadata.source):')
  for (const [k, n] of bucket(missing, (o) => paidSource.get(String(o.id)) ?? '(no order.paid audit row)')) {
    console.log('  ' + String(n).padStart(5) + '  ' + k)
  }
  console.log('\n  Only `terminal_callback` is anomalous. Everything else correctly has no sale event.')

  console.log('\nby payment_channel:')
  for (const [k, n] of bucket(missing, (o) => String(o.payment_channel ?? '(null)'))) console.log('  ' + String(n).padStart(5) + '  ' + k)
  console.log('\nby channel:')
  for (const [k, n] of bucket(missing, (o) => String(o.channel ?? '(null)'))) console.log('  ' + String(n).padStart(5) + '  ' + k)
  console.log('\nby payment_method:')
  for (const [k, n] of bucket(missing, (o) => String(o.payment_method ?? '(null)'))) console.log('  ' + String(n).padStart(5) + '  ' + k)
  console.log('\nhas a gateway reference (paycloud_merchant_order_no)?')
  for (const [k, n] of bucket(missing, (o) => (o.paycloud_merchant_order_no ? 'yes' : 'no'))) console.log('  ' + String(n).padStart(5) + '  ' + k)

  // ---------------------------------------------------------------- THE ANOMALY
  const anomalous = missing.filter((o) => paidSource.get(String(o.id)) === 'terminal_callback')
  console.log('')
  console.log('='.repeat(78))
  console.log(`THE REAL GAP — paid by terminal_callback, yet NO sale event: ${anomalous.length}`)
  console.log('='.repeat(78))
  if (anomalous.length === 0) {
    console.log('  none. Every missing sale event belongs to a path that never posts one, so the')
    console.log('  detector is NOT blind on terminal traffic — the 1144 was my filter, not the fleet.')
  } else {
    console.log('\n  by app version, from the payment.attempt_started audit row:')
    for (const [k, n] of bucket(anomalous, (o) => attemptVersion.get(String(o.id)) ?? '(no version recorded)')) {
      console.log('  ' + String(n).padStart(5) + '  ' + k)
    }
    console.log('\n  by venue:')
    for (const [k, n] of bucket(anomalous, (o) => nameOf.get(String(o.restaurant_id)) ?? String(o.restaurant_id))) {
      console.log('  ' + String(n).padStart(5) + '  ' + k)
    }
    console.log('\n  by month — a clean cut-off means it STOPPED working; a smear means it never worked:')
    for (const [k, n] of bucket(anomalous, (o) => String(o.paid_at ?? o.placed_at ?? '').slice(0, 7) || '(no date)').sort(([a], [b]) => a.localeCompare(b))) {
      console.log('  ' + String(n).padStart(5) + '  ' + k)
    }
  }

  // ---------------------------------------------------------------- the control
  const covered = orders.filter((o) => withSale.has(String(o.id)))
  console.log('')
  console.log('CONTROL — paid orders that DO have a sale event, by paying path:')
  for (const [k, n] of bucket(covered, (o) => paidSource.get(String(o.id)) ?? '(no order.paid audit row)')) {
    console.log('  ' + String(n).padStart(5) + '  ' + k)
  }
  console.log('\n  If terminal_callback appears in BOTH lists, some devices post sale events and some')
  console.log('  do not, and the version breakdown above says which.')

  console.log('\nPROBE_SALE_EVENT_GAP_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
