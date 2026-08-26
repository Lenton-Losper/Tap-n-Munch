// @ts-nocheck
/**
 * READ ONLY. TWO LOOSE ENDS FROM THE 876.
 *
 * 1. HAS A HOSTED CHECKOUT EVER RUN ON PRODUCTION AT ALL? Every one of the 876 carried
 *    payment_channel='hosted', and every one of them is a stress fixture. If no non-fixture row
 *    carries it, then the QR hosted-checkout path has no production traffic whatsoever -- which is
 *    a far stronger statement than "it is broken", and it decides whether the customer-side ceiling
 *    work has any live behaviour to be measured against.
 *
 * 2. WHO STAMPED THE BATCHES? Ten FNB ChowNow orders settled at the gateway within ~1-5 minutes and
 *    were stamped paid_at/completed_at later, several at a time, to the same millisecond. paid_at
 *    EQUALS completed_at on every one, which is the signature of a single UPDATE writing both.
 *    reconcileOrphanPayments writes exactly that shape -- but it is driven off payment_events 'sale'
 *    rows and these orders have none, so it is ruled OUT and something else did it. This lists every
 *    order production-wide where paid_at == completed_at and several orders share the instant, to
 *    show whether the pattern is confined to those ten or is a standing behaviour.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const FIXTURE = /^restaurant_test_/
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const t = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-')
const H = (x) => { console.log('\n' + '='.repeat(100)); console.log(x); console.log('='.repeat(100)) }
const tally = (list, f) => {
  const m = new Map()
  for (const o of list) { const k = String(f(o)); m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1])
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)

  const { data: venues } = await db.from('restaurants').select('id,name')
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders')
      .select('id,restaurant_id,firebase_restaurant_id,order_number,channel,payment_channel,payment_method,' +
        'payment_status,status,total,placed_at,paid_at,completed_at,cancelled_at,cancellation_reason,' +
        'payment_checkout_url,paycloud_merchant_order_no,payment_attempt_started_at,tab_id,table_number')
      .order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const isFixture = (o) => !o.restaurant_id && FIXTURE.test(String(o.firebase_restaurant_id ?? ''))
  const realRows = rows.filter((o) => !isFixture(o))
  console.log('orders ' + rows.length + '   stress fixtures ' + (rows.length - realRows.length) +
    '   real ' + realRows.length)

  // -------------------------------------------------------------- 1. hosted census
  H('1. PAYMENT_CHANNEL CENSUS')
  console.log('  ALL rows (fixtures included):')
  for (const [k, n] of tally(rows, (o) => o.payment_channel)) console.log('    ' + pad(k, 22) + String(n).padStart(5))
  console.log('\n  REAL rows (stress fixtures excluded):')
  for (const [k, n] of tally(realRows, (o) => o.payment_channel)) console.log('    ' + pad(k, 22) + String(n).padStart(5))

  const hosted = realRows.filter((o) => String(o.payment_channel ?? '').toLowerCase() === 'hosted')
  console.log('\n  non-fixture orders with payment_channel=hosted: ' + hosted.length)
  for (const o of hosted.slice(0, 25)) {
    console.log('    ' + pad(vname.get(o.restaurant_id) ?? '?', 16) + '#' + pad(o.order_number, 6) +
      pad(o.payment_status + '/' + o.status, 22) + 'N$' + pad(o.total, 8) + t(o.placed_at) +
      '  url=' + (o.payment_checkout_url ? 'yes' : 'no') + '  merchantNo=' + pad(o.paycloud_merchant_order_no, 22) +
      '  reason=' + pad(o.cancellation_reason, 18))
  }

  const anyCheckoutUrl = realRows.filter((o) => String(o.payment_checkout_url ?? '').trim())
  const anyMerchantNo = realRows.filter((o) => String(o.paycloud_merchant_order_no ?? '').trim())
  const anyAttempt = realRows.filter((o) => o.payment_attempt_started_at)
  console.log('\n  CORROBORATION on the same real population:')
  console.log('    with a payment_checkout_url        : ' + anyCheckoutUrl.length)
  console.log('    with a paycloud_merchant_order_no  : ' + anyMerchantNo.length)
  console.log('    with a payment_attempt_started_at  : ' + anyAttempt.length)
  console.log('    cancellation_reason=hosted_timeout : ' +
    realRows.filter((o) => o.cancellation_reason === 'hosted_timeout').length)

  // -------------------------------------------------------------- 2. batch stamping
  H('2. paid_at == completed_at, AND SHARED WITH ANOTHER ORDER -- the batch-stamp signature')
  const stamped = realRows.filter((o) => o.paid_at && o.completed_at && o.paid_at === o.completed_at)
  console.log('  real orders where paid_at == completed_at exactly: ' + stamped.length + ' of ' +
    realRows.filter((o) => o.paid_at).length + ' with any paid_at')
  const byInstant = new Map()
  for (const o of stamped) {
    const k = String(o.paid_at)
    if (!byInstant.has(k)) byInstant.set(k, [])
    byInstant.get(k).push(o)
  }
  const shared = [...byInstant].filter(([, l]) => l.length > 1).sort()
  console.log('  instants shared by more than one order: ' + shared.length +
    '   orders involved: ' + shared.reduce((s, [, l]) => s + l.length, 0))
  for (const [k, list] of shared) {
    console.log('    ' + t(k) + '  x' + list.length + '  ' +
      pad(vname.get(list[0].restaurant_id) ?? '?', 14) +
      list.map((o) => '#' + o.order_number + '(' + o.channel + '/' + (o.payment_method ?? '-') + ' N$' + o.total +
        ' tab=' + (o.tab_id ? String(o.tab_id).slice(0, 8) : '-') + ' tbl=' + o.table_number + ')').join(' '))
  }

  console.log('\n  the same instants, by venue and channel mix:')
  for (const [k, list] of shared) {
    const chans = [...new Set(list.map((o) => o.channel))].join(',')
    const meths = [...new Set(list.map((o) => o.payment_method))].join(',')
    const tabs = [...new Set(list.map((o) => String(o.tab_id ?? 'null')))]
    console.log('    ' + t(k) + '   channels=' + pad(chans, 12) + ' methods=' + pad(meths, 12) +
      ' distinct tab_ids=' + tabs.length + (tabs.length === 1 && tabs[0] !== 'null' ? '  <- ONE TAB' : '  <- NOT one tab'))
  }

  console.log('\nCENSUS_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
