// @ts-nocheck
/**
 * READ ONLY. WHAT ARE THE 876, IF THEY ARE NOT ORDERS?
 *
 * The first probe established what they are NOT: no venue, no money, no timestamp of any kind, no
 * gateway reference, no payments row, no receipt, no audit entry, and every single one placed in
 * the same one-second window on 2026-04-27. That is not traffic; that is a bulk insert.
 *
 * This one names it. Three questions:
 *   1. Does the whole 2026-04-27 02:34 block share one origin, and how big is the block really?
 *   2. Do the 876 sit inside #324's orphan set -- restaurant_id NULL and a
 *      firebase_restaurant_id matching restaurant_test_%? If so they are imported FIXTURE rows and
 *      the delete script already written for #324 is what removes them.
 *   3. With the fixtures excluded, what does QR card traffic actually look like? That is the number
 *      the ceiling work needs, and it is the only one of the three that is about the product.
 *
 * The exclusion is the point. A denominator that contains 876 fixture rows makes every share
 * computed against it meaningless, in either direction -- it manufactured a 98% failure rate here,
 * and it would just as happily manufacture a 98% success rate somewhere else.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const H = (t) => { console.log('\n' + '='.repeat(100)); console.log(t); console.log('='.repeat(100)) }
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
      .select('id,restaurant_id,firebase_restaurant_id,firebase_id,order_number,status,payment_status,' +
        'payment_method,payment_channel,channel,total,items,placed_at,paid_at,cancelled_at,completed_at,' +
        'is_closed,table_closed,table_number,session_id,idempotency_key,source_request_id,updated_at')
      .order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  console.log('orders read: ' + rows.length)

  const isQr = (o) => { const c = String(o.channel ?? '').toLowerCase(); return c !== 'pos' && c !== 'terminal' }
  const isCard = (o) => String(o.payment_method ?? '').toLowerCase() === 'card'
  const cohort = rows.filter((o) => isQr(o) && isCard(o) && o.payment_status === 'cancelled' && o.status === 'completed')

  // ------------------------------------------------------------- 1. the block
  H('1. THE 2026-04-27 BLOCK -- how big, and is it one insert?')
  const block = rows.filter((o) => String(o.placed_at ?? '').startsWith('2026-04-27'))
  console.log('  orders placed on 2026-04-27: ' + block.length + ' of ' + rows.length + ' (' +
    ((100 * block.length) / rows.length).toFixed(1) + '% of every order on production)')
  console.log('\n  distinct placed_at values inside the block:')
  for (const [k, n] of tally(block, (o) => o.placed_at).slice(0, 12)) console.log('    ' + pad(k, 34) + String(n).padStart(5))
  console.log('\n  distinct updated_at values inside the block:')
  for (const [k, n] of tally(block, (o) => o.updated_at).slice(0, 8)) console.log('    ' + pad(k, 34) + String(n).padStart(5))
  console.log('\n  the block by payment_method / channel / status:')
  for (const [label, f] of [
    ['payment_method', (o) => o.payment_method], ['channel', (o) => o.channel],
    ['payment_channel', (o) => o.payment_channel],
    ['payment_status|status', (o) => o.payment_status + ' | ' + o.status],
    ['total', (o) => o.total], ['items length', (o) => (Array.isArray(o.items) ? o.items.length : 'not-array')],
  ]) {
    console.log('    by ' + label + ': ' + tally(block, f).slice(0, 6).map(([k, n]) => k + '=' + n).join('   '))
  }

  // ------------------------------------------------------------- 2. are they #324's fixtures?
  H('2. ARE THE 876 #324 ORPHAN FIXTURES?')
  const nullRid = rows.filter((o) => !o.restaurant_id)
  const fixtures = rows.filter(isStressFixtureOrder)
  console.log('  restaurant_id IS NULL, production-wide : ' + nullRid.length)
  console.log('  of those, firebase_restaurant_id restaurant_test_% (#324 scope): ' + fixtures.length)
  console.log('  the 876 cohort, how many are in that scope: ' + cohort.filter(isStressFixtureOrder).length + ' of ' + cohort.length)
  console.log('  the 876 cohort, how many have a restaurant_id at all: ' + cohort.filter((o) => o.restaurant_id).length)
  console.log('\n  cohort firebase_restaurant_id prefixes:')
  for (const [k, n] of tally(cohort, (o) => String(o.firebase_restaurant_id ?? 'NULL').slice(0, 26)).slice(0, 8)) {
    console.log('    ' + pad(k, 30) + String(n).padStart(5))
  }
  console.log('\n  three raw cohort rows, every field that carries anything:')
  for (const o of cohort.slice(0, 3)) {
    const kept = Object.entries(o).filter(([, v]) =>
      v !== null && v !== undefined && v !== false && v !== 0 && !(Array.isArray(v) && v.length === 0))
    console.log('    ' + kept.map(([k, v]) => k + '=' + String(JSON.stringify(v)).slice(0, 46)).join('  '))
  }

  // ------------------------------------------------------------- 3. real QR traffic
  H('3. QR CARD TRAFFIC WITH THE FIXTURES EXCLUDED')
  const realQrCard = rows.filter((o) => isQr(o) && isCard(o) && !isStressFixtureOrder(o))
  console.log('  QR card orders, fixtures excluded: ' + realQrCard.length + '   (the 891 figure was ' +
    rows.filter((o) => isQr(o) && isCard(o)).length + ')')
  for (const [k, n] of tally(realQrCard, (o) => o.payment_status + ' | ' + o.status)) console.log('    ' + pad(k, 30) + String(n).padStart(4))
  console.log('\n  by venue:')
  for (const [k, n] of tally(realQrCard, (o) => vname.get(o.restaurant_id) ?? String(o.restaurant_id))) console.log('    ' + pad(k, 30) + String(n).padStart(4))
  console.log('\n  by payment_channel: ' + tally(realQrCard, (o) => o.payment_channel).map(([k, n]) => k + '=' + n).join('  '))

  const realQr = rows.filter((o) => isQr(o) && !isStressFixtureOrder(o))
  console.log('\n  ALL QR orders, fixtures excluded: ' + realQr.length +
    '   (the 1358 figure the customer-wait script used was ' + rows.filter(isQr).length + ')')
  console.log('  by payment_method: ' + tally(realQr, (o) => o.payment_method).map(([k, n]) => k + '=' + n).join('  '))

  // ------------------------------------------------------------- 4. the batch flips
  H('4. THE SLOW FLIPS -- are they one settlement each, or several orders at once?')
  const paidQr = realQrCard.filter((o) => o.paid_at)
  const byInstant = tally(paidQr, (o) => o.paid_at)
  console.log('  ' + paidQr.length + ' paid QR card orders share ' + byInstant.length + ' distinct paid_at instants:')
  for (const [k, n] of byInstant) {
    const at = paidQr.filter((o) => o.paid_at === k)
    console.log('    ' + pad(k, 30) + n + ' order(s)   ' +
      at.map((o) => '#' + o.order_number + ' N$' + o.total + ' placed ' + String(o.placed_at).slice(11, 16)).join('   '))
  }
  console.log('\n  a paid_at shared by several orders is ONE settlement of a tab, not N hosted checkouts.')

  const paysById = new Map()
  const pays = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('payments').select('*').range(f, f + 999)
    if (error) { console.log('  payments: ERROR ' + error.message); break }
    pays.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  for (const p of pays) for (const oid of (p.order_ids ?? [])) {
    if (!paysById.has(String(oid))) paysById.set(String(oid), [])
    paysById.get(String(oid)).push(p)
  }
  console.log('\n  the payments rows behind them:')
  for (const o of paidQr.sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)))) {
    const ps = paysById.get(String(o.id)) ?? []
    console.log('    #' + pad(o.order_number, 5) + pad(vname.get(o.restaurant_id) ?? '?', 14) +
      'N$' + pad(o.total, 7) + 'paid ' + pad(String(o.paid_at).slice(0, 16).replace('T', ' '), 18) +
      (ps.length
        ? ps.map((p) => 'payment[' + p.method + ' ' + p.status + ' N$' + p.amount + ' orders=' +
            (p.order_ids ?? []).length + ' gw=' + (p.gateway_reference ?? '-') + ']').join(' ')
        : 'NO payments ROW'))
  }

  console.log('\nORIGIN_PROBE_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
