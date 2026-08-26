// @ts-nocheck
/**
 * READ ONLY. WHAT THE FIXTURES DID TO YESTERDAY'S MEASUREMENT.
 *
 * measure-customer-wait-20260825.ts reported "only 43 of 1358 QR orders carry a session_id" and
 * concluded the re-place scan was blind because session ids are mostly absent. 1314 of that 1358
 * are stress fixtures carrying session_id='' -- so the reported cause is wrong even though the
 * conclusion (not measurable) is right. Recomputing the same control on the real population says
 * which it is: sessions are missing, or there is simply almost no QR traffic to scan.
 *
 * Those are not the same finding. One is an instrument fault worth fixing before the ceiling work;
 * the other says the QR customer path has barely been used on production and no amount of
 * instrumentation will produce a measurement until it is.
 *
 * Also lists every venue with its real order counts, because "876 orders" and "876 orders at a
 * venue that is a test account" are different sentences.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const H = (x) => { console.log('\n' + '='.repeat(100)); console.log(x); console.log('='.repeat(100)) }

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)

  const { data: venues } = await db.from('restaurants').select('*')
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders')
      .select('id,restaurant_id,firebase_restaurant_id,order_number,channel,payment_method,payment_status,' +
        'status,total,session_id,member_session_id,placed_at,paid_at')
      .order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const isQr = (o) => { const c = String(o.channel ?? '').toLowerCase(); return c !== 'pos' && c !== 'terminal' }
  const real = rows.filter((o) => !isStressFixtureOrder(o))

  H('1. THE SESSION-ID CONTROL, RECOMPUTED WITHOUT THE FIXTURES')
  for (const [label, pop] of [['as reported yesterday (fixtures INCLUDED)', rows.filter(isQr)],
                              ['real population (fixtures EXCLUDED)', real.filter(isQr)]]) {
    const withS = pop.filter((o) => String(o.session_id ?? '').trim())
    const bySession = new Map()
    for (const o of withS) {
      const k = String(o.session_id)
      if (!bySession.has(k)) bySession.set(k, [])
      bySession.get(k).push(o)
    }
    const multi = [...bySession.values()].filter((l) => l.length > 1)
    console.log('\n  ' + label)
    console.log('    QR orders                       : ' + pop.length)
    console.log('    carrying a non-empty session_id : ' + withS.length +
      '  (' + ((100 * withS.length) / Math.max(1, pop.length)).toFixed(1) + '%)')
    console.log('    distinct sessions               : ' + bySession.size)
    console.log('    sessions holding >1 order       : ' + multi.length)
    for (const l of multi.slice(0, 8)) {
      console.log('      ' + pad(vname.get(l[0].restaurant_id) ?? '?', 14) + l.length + ' orders: ' +
        l.map((o) => '#' + o.order_number + '(' + o.payment_status + ' N$' + o.total + ')').join(' '))
    }
  }

  H('2. EVERY VENUE, WITH ITS REAL ORDER COUNTS')
  console.log('  ' + pad('venue', 22) + pad('orders', 8) + pad('QR', 6) + pad('QRcard', 8) +
    pad('POS', 7) + pad('paid', 7) + pad('N$ paid', 12) + 'first order        last order')
  const rowsByVenue = new Map()
  for (const o of real) {
    const k = String(o.restaurant_id ?? 'NULL')
    if (!rowsByVenue.has(k)) rowsByVenue.set(k, [])
    rowsByVenue.get(k).push(o)
  }
  for (const [k, list] of [...rowsByVenue].sort((a, b) => b[1].length - a[1].length)) {
    const qr = list.filter(isQr)
    const paid = list.filter((o) => o.payment_status === 'paid')
    console.log('  ' + pad(vname.get(k) ?? k, 22) + pad(list.length, 8) + pad(qr.length, 6) +
      pad(qr.filter((o) => String(o.payment_method ?? '').toLowerCase() === 'card').length, 8) +
      pad(list.length - qr.length, 7) + pad(paid.length, 7) +
      pad('N$' + paid.reduce((s, o) => s + Number(o.total ?? 0), 0).toFixed(0), 12) +
      pad(String(list[0].placed_at).slice(0, 10), 19) + String(list[list.length - 1].placed_at).slice(0, 10))
  }

  console.log('\n  restaurants table columns: ' + Object.keys(venues?.[0] ?? {}).join(', '))

  console.log('\nDENOMINATOR_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
