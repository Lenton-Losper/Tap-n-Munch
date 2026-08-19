/**
 * WHAT STATE IS THE ORDER BEHIND FT17871220357211600 IN? Production, strictly read-only.
 *
 * A card DECLINE on Mingle's terminal, 2026-08-19 08:47:36, Visa, NAD 25.00, merchant
 * 342600160494 — "Network connectivity failure" per Finatic's dashboard. The card network failed
 * between terminal and acquirer; FlashTap is not in that path.
 *
 * THE QUESTION IS NOT WHOSE FAULT THE DECLINE WAS. It is what the decline LEFT BEHIND. The device
 * was running an old build without #182 (staff-readable failure text) and #183 (orphaned cancel no
 * longer misreported as ambiguous), and a decline mid-flow is exactly what those two are about.
 *
 * The specific ways this can go wrong, each checked below rather than assumed:
 *
 *   1. the order stuck at payment_status='pending' with a merchant_order_no, forever
 *   2. status='cancelled' while payment_status stays 'pending' (#82's contradictory pair)
 *   3. paid + cancelled simultaneously
 *   4. marked paid on a DECLINED transaction — the one that costs money
 *   5. left in 'terminal_pending' / mid-flight with nothing to resolve it
 *
 * SELECTS ONLY. No insert, update, delete or rpc. Refuses to run unless SUPABASE_URL is the
 * production project.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

const TXN = 'FT17871220357211600'
const MERCHANT = '342600160494'
const WINDOW_FROM = '2026-08-19T07:30:00Z'
const WINDOW_TO = '2026-08-19T10:00:00Z'

const show = (label: string, v: unknown) => console.log(`      ${label.padEnd(26)} ${v ?? '(null)'}`)

async function main() {
  console.log('\nPRODUCTION — the order behind the 08:47 Mingle decline. Read-only.\n')

  const { data: ctl, error: ctlErr } = await admin.from('orders').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] orders readable and non-empty : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  const cols =
    'id, order_number, restaurant_id, table_number, status, payment_status, payment_method, payment_channel, ' +
    'total, paid_at, cancelled_at, cancellation_reason, paycloud_merchant_order_no, paycloud_transaction_id, ' +
    'terminal_status, placed_at, created_at, tab_id, channel'

  // ------------------------------------------------------- 1. by the transaction reference
  const hits: Record<string, any[]> = {}
  for (const [label, q] of [
    ['orders.paycloud_transaction_id', admin.from('orders').select(cols).eq('paycloud_transaction_id', TXN)],
    ['orders.paycloud_merchant_order_no', admin.from('orders').select(cols).eq('paycloud_merchant_order_no', TXN)],
  ] as const) {
    const { data, error } = await q
    if (error) console.log(`  ${label}: READ FAILED ${error.message}`)
    hits[label] = data ?? []
    console.log(`  ${label.padEnd(34)} ${data?.length ?? 0} row(s)`)
  }

  // ------------------------------------------------------- 2. payment_events by business_order_no
  const { data: events } = await admin
    .from('payment_events')
    .select('id, event_type, business_order_no, order_ids, amount, created_at')
    .or(`business_order_no.eq.${TXN},business_order_no.eq.${MERCHANT}`)
  console.log(`  payment_events matching ref/merchant  ${events?.length ?? 0} row(s)`)
  for (const e of events ?? []) {
    console.log(`      ${e.created_at}  ${e.event_type}  amount=${e.amount}  orders=${JSON.stringify(e.order_ids)}`)
  }

  // ------------------------------------------------------- 3. the time window at Mingle
  const { data: rests } = await admin.from('restaurants').select('id, name')
  const mingle = (rests ?? []).find((r) => /mingle/i.test(String(r.name)))
  console.log(`\n  Mingle restaurant_id: ${mingle?.id ?? 'NOT FOUND'}`)

  let windowRows: any[] = []
  if (mingle?.id) {
    const { data } = await admin
      .from('orders')
      .select(cols)
      .eq('restaurant_id', mingle.id)
      .gte('created_at', WINDOW_FROM)
      .lte('created_at', WINDOW_TO)
      .order('created_at', { ascending: true })
    windowRows = data ?? []
  }
  console.log(`  orders at Mingle ${WINDOW_FROM} .. ${WINDOW_TO}: ${windowRows.length}`)

  const all = [...hits['orders.paycloud_transaction_id'], ...hits['orders.paycloud_merchant_order_no'], ...windowRows]
  const byId = new Map(all.map((o) => [String(o.id), o]))

  if (byId.size === 0) {
    console.log('\n  NO ORDER FOUND by reference or in the window.')
    console.log('  That is itself an answer: a decline that never produced an order row leaves nothing')
    console.log('  stuck. It also means the reference lives only on Finatic\'s side, which is what a')
    console.log('  failure BEFORE prepare-payment would look like.')
    return
  }

  console.log(`\n  ${byId.size} candidate order(s):\n`)
  for (const o of byId.values()) {
    console.log(`  ORDER ${o.id}  #${o.order_number ?? '(none)'}  table ${o.table_number}`)
    show('created_at', o.created_at)
    show('status', o.status)
    show('payment_status', o.payment_status)
    show('terminal_status', o.terminal_status)
    show('payment_method / channel', `${o.payment_method} / ${o.payment_channel}`)
    show('total', o.total)
    show('paid_at', o.paid_at)
    show('cancelled_at', o.cancelled_at)
    show('cancellation_reason', o.cancellation_reason)
    show('merchant_order_no', o.paycloud_merchant_order_no)
    show('transaction_id', o.paycloud_transaction_id)

    // ---- the five failure shapes, named
    const ps = String(o.payment_status || '').toLowerCase()
    const st = String(o.status || '').toLowerCase()
    const flags: string[] = []
    if (ps === 'paid' && (o.cancelled_at || st === 'cancelled')) flags.push('*** PAID AND CANCELLED — contradictory')
    if (ps === 'paid') flags.push('*** MARKED PAID on a transaction Finatic DECLINED — check this first')
    if (st === 'cancelled' && ps === 'pending' && !o.cancellation_reason) flags.push('cancelled with payment_status still pending and no reason (#82 shape)')
    if (ps === 'pending' && o.paycloud_merchant_order_no) flags.push('pending WITH a merchant_order_no — the stuck-forever shape (#153/#158)')
    if (ps === 'terminal_pending') flags.push('left mid-flight at terminal_pending')
    if (ps === 'paid' && !o.paid_at) flags.push('paid with NO paid_at — invisible to the receipt sweep (#234)')
    console.log(flags.length ? `      FLAGS: ${flags.join(' | ')}` : '      FLAGS: none — state looks internally consistent')

    const { data: audits } = await admin
      .from('audit_logs')
      .select('action, created_at, metadata')
      .eq('entity_id', o.id)
      .order('created_at', { ascending: true })
    console.log(`      audit rows: ${audits?.length ?? 0}`)
    for (const a of audits ?? []) console.log(`        ${a.created_at}  ${a.action}`)
    console.log('')
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
