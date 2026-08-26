// @ts-nocheck
/**
 * READ ONLY. WHICH LIVE SURFACES CAN ACTUALLY SEE A STRESS FIXTURE?
 *
 * A static sweep of app/ and lib/ found 149 `.from('orders')` call sites, of which 124 filter on
 * restaurant_id / id / tab_id / table_id and therefore cannot reach a row whose restaurant_id is
 * NULL. The remaining 25 have to be decided against the fixtures' ACTUAL column values rather than
 * by reading the query, because most of them are excluded by a value (payment_status='paid',
 * paid_at NOT NULL, a merchant order number) rather than by scope.
 *
 * This script answers the three that a code read cannot:
 *
 *   1. Does any REAL restaurant carry a firebase_id matching restaurant_test_%? Two order-number
 *      counters (app/api/orders/route.ts:488, lib/orders/create-order.ts:66) count rows by
 *      firebase_restaurant_id and use count+1 as the next order number. A collision would offset
 *      every new order number at that venue by the number of fixtures sharing its id.
 *   2. What does the platform search return for an order number in the fixture range? That query
 *      (app/api/platform/search/route.ts:98) filters on order_number ALONE.
 *   3. Which fixture column values would clear the value-based filters — 'paid', 'failed', a
 *      merchant order number, a recent placed_at — so that "safe today" can be separated from
 *      "safe by construction".
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder, STRESS_FIXTURE_FIREBASE_PREFIX } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const H = (x) => { console.log('\n' + '='.repeat(96)); console.log(x); console.log('='.repeat(96)) }

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)

  // ---------------------------------------------------------- 1. the order-number counter
  H('1. THE ORDER-NUMBER COUNTER — does a real venue share a firebase_id with the fixtures?')
  const { data: venues } = await db.from('restaurants').select('id,name,firebase_id,is_active,deleted_at')
  console.log('  restaurants: ' + (venues ?? []).length)
  const colliding = (venues ?? []).filter((v) => String(v.firebase_id ?? '').startsWith(STRESS_FIXTURE_FIREBASE_PREFIX))
  for (const v of venues ?? []) {
    console.log('    ' + pad(v.name, 24) + 'firebase_id=' + pad(v.firebase_id, 26) +
      'active=' + pad(v.is_active, 6) + 'deleted=' + pad(v.deleted_at, 12))
  }
  console.log('\n  venues whose firebase_id matches restaurant_test_%: ' + colliding.length +
    (colliding.length === 0
      ? '   -> the two counters cannot be offset by a fixture. SAFE BY CONSTRUCTION.'
      : '   -> *** THE COUNTER AT THESE VENUES IS OFFSET BY THE FIXTURE COUNT ***'))

  // ---------------------------------------------------------- 2. platform search by order number
  H('2. PLATFORM SEARCH BY ORDER NUMBER — app/api/platform/search/route.ts:98')
  console.log('  That query filters on order_number ALONE: .eq(order_number, N).limit(10)')
  const fixtureNumbers = new Map()
  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders')
      .select('id,restaurant_id,firebase_restaurant_id,order_number,payment_status,status,total,placed_at,paid_at,paycloud_merchant_order_no,payment_reference,payment_voucher_no')
      .order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const fixtures = rows.filter(isStressFixtureOrder)
  const real = rows.filter((o) => !isStressFixtureOrder(o))
  for (const o of fixtures) fixtureNumbers.set(o.order_number, (fixtureNumbers.get(o.order_number) ?? 0) + 1)

  const nums = [...fixtureNumbers.keys()].sort((a, b) => a - b)
  console.log('  fixture order_number range: ' + nums[0] + '..' + nums[nums.length - 1] +
    '   distinct values: ' + nums.length)
  console.log('\n  what a platform admin searching these numbers gets back (limit 10, newest first):')
  for (const n of [1, 5, 20, 50, 100, 142]) {
    const fx = fixtures.filter((o) => o.order_number === n).length
    const rl = real.filter((o) => o.order_number === n).length
    const bothSorted = rows.filter((o) => o.order_number === n)
      .sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at))).slice(0, 10)
    const fxInTop10 = bothSorted.filter(isStressFixtureOrder).length
    console.log('    order_number ' + String(n).padStart(4) + ':  ' + String(fx).padStart(4) + ' fixture, ' +
      String(rl).padStart(4) + ' real   -> of the 10 rows returned, ' + fxInTop10 + ' are fixtures' +
      (fxInTop10 === 10 ? '   *** ALL TEN ***' : ''))
  }

  // ---------------------------------------------------------- 3. safe by value, or safe by date?
  H('3. WHICH VALUE FILTERS EXCLUDE THE FIXTURES, AND WHICH ONLY EXCLUDE THEM TODAY')
  const count = (f) => fixtures.filter(f).length
  const checks = [
    ["payment_status='paid'", (o) => o.payment_status === 'paid', 'by construction'],
    ["payment_status='failed'", (o) => o.payment_status === 'failed', 'by construction'],
    ["status in (canceled,cancelled)", (o) => ['canceled', 'cancelled'].includes(String(o.status)), 'by construction'],
    ['paid_at IS NOT NULL', (o) => Boolean(o.paid_at), 'by construction'],
    ['paycloud_merchant_order_no IS NOT NULL', (o) => Boolean(o.paycloud_merchant_order_no), 'by construction'],
    ['payment_reference IS NOT NULL', (o) => Boolean(o.payment_reference), 'by construction'],
    ['payment_voucher_no IS NOT NULL', (o) => Boolean(o.payment_voucher_no), 'by construction'],
  ]
  for (const [label, f, kind] of checks) {
    const n = count(f)
    console.log('  ' + pad(label, 42) + 'fixtures matching: ' + String(n).padStart(5) +
      (n === 0 ? '   EXCLUDED ' + kind : '   *** REACHES ' + n + ' FIXTURES ***'))
  }

  const now = Date.now()
  const newest = fixtures.map((o) => new Date(o.placed_at).getTime()).sort((a, b) => b - a)[0]
  const ageDays = (now - newest) / 86400000
  console.log('\n  placed_at windows — these exclude the fixtures BY DATE, not by construction:')
  console.log('    newest fixture placed_at: ' + new Date(newest).toISOString().slice(0, 19) +
    '   (' + ageDays.toFixed(0) + ' days ago)')
  for (const [label, days] of [['platform analytics 14-day window', 14], ['30-day paid window', 30], ['today', 1]]) {
    const inWindow = fixtures.filter((o) => (now - new Date(o.placed_at).getTime()) / 86400000 <= days).length
    console.log('    ' + pad(label, 38) + inWindow + ' fixtures inside it' +
      (inWindow === 0 ? '   (excluded, but only because they are old)' : '   *** INSIDE ***'))
  }
  console.log('\n  A date window is not an exclusion. It stops being one the moment anyone re-runs')
  console.log('  the stress test, or widens a report to "all time".')

  console.log('\nREACHABILITY_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
