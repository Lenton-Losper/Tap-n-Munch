// @ts-nocheck
/**
 * READ ONLY. THE FIFTEEN REAL QR CARD ORDERS, one row each, with every corroborating record.
 *
 * With the 1314 stress fixtures excluded, production has fifteen customer-placed card orders. That
 * is the whole population, so it can be read individually rather than summarised -- and it must be,
 * because a percentile over fifteen rows is theatre.
 *
 * The question this answers is the second one: seven of the fourteen paid orders took over an hour
 * from placed_at to paid_at. Is that the hosted checkout being slow, or something failing and
 * recovering late? The two look identical in the orders table and are told apart by WHEN THE MONEY
 * ACTUALLY ARRIVED -- payments.created_at / completed_at and the payment_events row -- against when
 * the order was stamped.
 *
 *   gateway time ~= order paid_at            -> the wait was real; the customer sat there.
 *   gateway time much EARLIER than paid_at   -> the money arrived on time and the ORDER was stamped
 *                                               late by a sweep. The customer never waited; the
 *                                               dashboard did.
 *
 * A paid_at shared to the millisecond by several orders whose gateway references differ is the
 * signature of the second: one bulk UPDATE ... .in('id', plainIds), which is exactly the shape of
 * reconcileOrphanPayments' plainIds branch (lib/payments/reconcile-orphan-payments.ts:214-222).
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const t = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-')
const H = (x) => { console.log('\n' + '='.repeat(100)); console.log(x); console.log('='.repeat(100)) }

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
    const { data, error } = await db.from('orders').select('*').order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const isQr = (o) => { const c = String(o.channel ?? '').toLowerCase(); return c !== 'pos' && c !== 'terminal' }
  const isCard = (o) => String(o.payment_method ?? '').toLowerCase() === 'card'
  const real = rows.filter((o) => isQr(o) && isCard(o) && !isStressFixtureOrder(o))
    .sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)))

  const pays = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('payments').select('*').range(f, f + 999)
    if (error) { console.log('payments ERROR ' + error.message); break }
    pays.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const events = []
  {
    const { data, error } = await db.from('payment_events').select('*').limit(2000)
    if (error) console.log('payment_events ERROR ' + error.message)
    else events.push(...(data ?? []))
  }
  console.log('payments rows ' + pays.length + '   payment_events rows ' + events.length)

  const audits = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('audit_logs').select('*').eq('entity_type', 'order').range(f, f + 999)
    if (error) { console.log('audit ERROR ' + error.message); break }
    audits.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const receipts = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('receipt_documents').select('id,order_id,document_type,document_number,status,issued_at').range(f, f + 999)
    if (error) { console.log('receipts ERROR ' + error.message); break }
    receipts.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  H('THE FIFTEEN, one block each')
  for (const o of real) {
    const id = String(o.id)
    const mine = pays.filter((p) => (p.order_ids ?? []).map(String).includes(id))
    const evs = events.filter((e) => (e.order_ids ?? []).map(String).includes(id))
    const auds = audits.filter((a) => String(a.entity_id) === id)
    const recs = receipts.filter((r) => String(r.order_id) === id)
    const waitMin = o.paid_at && o.placed_at
      ? ((new Date(o.paid_at).getTime() - new Date(o.placed_at).getTime()) / 60000) : null

    console.log('\n' + '-'.repeat(100))
    console.log(pad(vname.get(o.restaurant_id) ?? '?', 14) + ' #' + pad(o.order_number, 5) +
      ' table ' + pad(o.table_number, 4) + ' N$' + pad(o.total, 8) +
      ' ' + pad(o.payment_status + '/' + o.status, 22) +
      ' paych=' + pad(o.payment_channel, 12) + ' provider=' + pad(o.payment_provider, 10))
    console.log('  placed   ' + t(o.placed_at) + '    accepted ' + t(o.accepted_at) +
      '    completed ' + t(o.completed_at))
    console.log('  paid_at  ' + t(o.paid_at) + '    attempt_started ' + t(o.payment_attempt_started_at) +
      '    updated ' + t(o.updated_at))
    console.log('  WAIT placed->paid: ' + (waitMin === null ? '-' : waitMin.toFixed(1) + ' min' +
      (waitMin > 60 ? '   <-- OVER AN HOUR' : '')))
    console.log('  refs: reference=' + pad(o.payment_reference, 40) + ' merchantNo=' + pad(o.paycloud_merchant_order_no, 24))
    console.log('        txnId=' + pad(o.paycloud_transaction_id, 24) + ' transNo=' + pad(o.payment_trans_no, 18) +
      ' voucher=' + pad(o.payment_voucher_no, 12))
    console.log('        checkoutUrl=' + (o.payment_checkout_url ? 'YES' : 'no') +
      '   attempt_source=' + pad(o.payment_attempt_source, 14) + ' terminal_sn=' + pad(o.terminal_sn, 18))
    if (mine.length) for (const p of mine) {
      console.log('  PAYMENT  method=' + pad(p.method, 8) + ' status=' + pad(p.status, 11) + ' N$' + pad(p.amount, 8) +
        ' created ' + t(p.created_at) + '  completed ' + t(p.completed_at) +
        '  gw=' + pad(p.gateway_reference, 34) + ' ref=' + pad(p.payment_reference, 20) +
        ' covers ' + (p.order_ids ?? []).length + ' order(s)')
      if (p.completed_at && o.paid_at) {
        const lag = (new Date(o.paid_at).getTime() - new Date(p.completed_at).getTime()) / 60000
        console.log('           gateway completed -> order stamped paid: ' + lag.toFixed(1) + ' min' +
          (lag > 5 ? '   <-- THE ORDER WAS STAMPED LATE, the money was not' : ''))
      }
    } else console.log('  PAYMENT  none')
    for (const e of evs) console.log('  EVENT    type=' + pad(e.event_type, 10) + ' N$' + pad(e.amount, 8) +
      ' businessNo=' + pad(e.business_order_no, 24) + ' created ' + t(e.created_at) + ' covers ' + (e.order_ids ?? []).length)
    if (!evs.length) console.log('  EVENT    none')
    for (const a of auds) console.log('  AUDIT    ' + pad(a.action, 30) + t(a.created_at) +
      '  src=' + pad(a.metadata?.source, 30) + ' ' + JSON.stringify(a.metadata ?? {}).slice(0, 90))
    if (!auds.length) console.log('  AUDIT    none')
    for (const r of recs) console.log('  RECEIPT  ' + pad(r.document_type, 16) + pad(r.document_number, 18) +
      pad(r.status, 10) + t(r.issued_at))
    if (!recs.length) console.log('  RECEIPT  none')
  }

  H('THE SHARED-INSTANT TEST -- do orders that share a paid_at share a payment?')
  const byInstant = new Map()
  for (const o of real.filter((o) => o.paid_at)) {
    const k = String(o.paid_at)
    if (!byInstant.has(k)) byInstant.set(k, [])
    byInstant.get(k).push(o)
  }
  for (const [k, list] of [...byInstant].sort()) {
    if (list.length < 2) continue
    const gws = list.map((o) => {
      const p = pays.find((p) => (p.order_ids ?? []).map(String).includes(String(o.id)))
      return p ? String(p.gateway_reference).slice(0, 10) : 'none'
    })
    console.log('  ' + t(k) + '  ' + list.length + ' orders: ' +
      list.map((o) => '#' + o.order_number).join(',') + '   gateway refs: ' + gws.join(', ') +
      (new Set(gws).size === list.length && gws[0] !== 'none'
        ? '   -> DISTINCT payments, ONE stamping write'
        : '   -> shared or absent'))
  }

  console.log('\nFIFTEEN_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
