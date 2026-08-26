// @ts-nocheck
/**
 * READ ONLY. HAS THE CASH-SETTLE EVICTION HAPPENED TO A REAL CUSTOMER?
 *
 * THE MECHANISM, traced in code at 5c786956 and confirmed here against data:
 *
 *   1. customer taps Settle -> chooses a payment method
 *   2. POST /api/tabs/[tabId]/ready-to-pay sets tabs.status = 'ready_to_pay'
 *   3. validateSessionToken (lib/session-token.ts:110) requires tabs.status === 'open'
 *   4. the /tab screen polls every 5s through fetchWithSession
 *   5. next tick -> 410 -> handleSessionExpired -> token, tab id, table and CART cleared,
 *      window.location.replace('/session-ended')
 *
 * So the customer is evicted within ~5 seconds of asking to pay, having paid nothing.
 *
 * WHAT THIS SCRIPT ANSWERS, and what it deliberately does NOT claim.
 *
 * The eviction leaves no marker of its own — no audit row, no column. What it DOES leave is a tab
 * sitting in `ready_to_pay` with money still owed. So this measures the FOOTPRINT:
 *
 *   A. tabs in ready_to_pay right now, with what is outstanding on them
 *   B. how long they have been there — a few minutes is a customer waiting, a day is one abandoned
 *   C. tabs that reached ready_to_pay and were LATER settled: staff did recover the money
 *   D. tabs settled as CASH and what their orders' payment_status actually says
 *
 * A tab in ready_to_pay is NOT proof a customer was evicted — staff may simply not have arrived
 * yet. The honest signal is the OLD ones, and (C) is the control: if tabs do get settled after
 * reaching ready_to_pay, the path is recoverable and the loss is the customer's session, not the
 * money.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const t = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-')
const H = (x) => { console.log('\n' + '='.repeat(96)); console.log(x); console.log('='.repeat(96)) }

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)

  const { data: venues } = await db.from('restaurants').select('id,name')
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const tabs = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('tabs')
      .select('id,restaurant_id,table_number,status,payment_preference,ready_to_pay_at,settled_at,settled_type,total,created_at')
      .order('created_at').range(f, f + 999)
    if (error) throw new Error('tabs: ' + error.message)
    tabs.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const orders = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders')
      .select('id,tab_id,restaurant_id,total,payment_status,payment_method,paid_at,placed_at,status')
      .not('tab_id', 'is', null).order('placed_at').range(f, f + 999)
    if (error) throw new Error('orders: ' + error.message)
    orders.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const byTab = new Map()
  for (const o of orders) {
    const k = String(o.tab_id)
    if (!byTab.has(k)) byTab.set(k, [])
    byTab.get(k).push(o)
  }
  const owed = (tabId) =>
    (byTab.get(String(tabId)) ?? [])
      .filter((o) => String(o.payment_status) !== 'paid' && String(o.status) !== 'cancelled')
      .reduce((s, o) => s + Number(o.total ?? 0), 0)

  H('1. THE POPULATION')
  console.log('  tabs                ' + tabs.length)
  const byStatus = new Map()
  for (const t2 of tabs) byStatus.set(String(t2.status), (byStatus.get(String(t2.status)) ?? 0) + 1)
  for (const [k, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log('    ' + pad(k, 18) + n)
  console.log('  tabs that ever reached ready_to_pay (ready_to_pay_at set): ' +
    tabs.filter((x) => x.ready_to_pay_at).length)

  H('2. STUCK IN ready_to_pay RIGHT NOW — the eviction footprint')
  const now = Date.now()
  const stuck = tabs.filter((x) => String(x.status) === 'ready_to_pay')
  console.log('  ' + stuck.length + ' tab(s)')
  if (stuck.length) {
    console.log('  ' + pad('venue', 20) + pad('tbl', 5) + pad('pref', 7) + pad('ready_to_pay_at', 20) +
      pad('age', 10) + pad('owed N$', 10) + 'settled?')
    for (const x of stuck.sort((a, b) => String(a.ready_to_pay_at).localeCompare(String(b.ready_to_pay_at)))) {
      const ageH = x.ready_to_pay_at ? (now - new Date(x.ready_to_pay_at).getTime()) / 3600000 : null
      console.log('  ' + pad(vname.get(x.restaurant_id) ?? '?', 20) + pad(x.table_number, 5) +
        pad(x.payment_preference, 7) + pad(t(x.ready_to_pay_at), 20) +
        pad(ageH === null ? '-' : ageH < 48 ? ageH.toFixed(1) + 'h' : (ageH / 24).toFixed(1) + 'd', 10) +
        pad(owed(x.id).toFixed(2), 10) + (x.settled_at ? 'settled ' + t(x.settled_at) : 'NO'))
    }
  }
  console.log('\n  by preference: ' + [...new Set(stuck.map((x) => String(x.payment_preference)))]
    .map((p) => p + '=' + stuck.filter((x) => String(x.payment_preference) === p).length).join('  '))

  H('3. THE CONTROL — did any tab reach ready_to_pay and then GET SETTLED?')
  const reached = tabs.filter((x) => x.ready_to_pay_at)
  const settledAfter = reached.filter((x) => x.settled_at)
  console.log('  reached ready_to_pay: ' + reached.length + '   of those SETTLED afterwards: ' + settledAfter.length)
  console.log('  (if this is > 0 the path is recoverable: staff can still take the money after the')
  console.log('   customer is evicted, and what is lost is the session rather than the payment.)')
  for (const x of settledAfter.slice(0, 12)) {
    const gapMin = (new Date(x.settled_at).getTime() - new Date(x.ready_to_pay_at).getTime()) / 60000
    console.log('    ' + pad(vname.get(x.restaurant_id) ?? '?', 20) + 'tbl ' + pad(x.table_number, 5) +
      pad(x.payment_preference, 7) + 'ready ' + pad(t(x.ready_to_pay_at), 20) +
      'settled ' + pad(t(x.settled_at), 20) + 'after ' +
      (gapMin > 1440 ? (gapMin / 1440).toFixed(1) + 'd' : gapMin.toFixed(0) + 'm') +
      '  type=' + (x.settled_type ?? '-'))
  }

  H('4. TABS SETTLED AS CASH — is the money recorded on the orders?')
  const cashSettled = tabs.filter((x) => String(x.settled_type ?? '').toLowerCase().includes('cash'))
  console.log('  settled_type mentions cash: ' + cashSettled.length)
  let unpaidOnCashSettled = 0
  for (const x of cashSettled) {
    const rows = byTab.get(String(x.id)) ?? []
    const unpaid = rows.filter((o) => String(o.payment_status) !== 'paid' && String(o.status) !== 'cancelled')
    if (unpaid.length) unpaidOnCashSettled++
    console.log('    ' + pad(vname.get(x.restaurant_id) ?? '?', 20) + 'tbl ' + pad(x.table_number, 5) +
      pad(t(x.settled_at), 20) + 'orders ' + pad(rows.length, 4) +
      'unpaid ' + pad(unpaid.length, 4) +
      (unpaid.length ? '*** N$' + unpaid.reduce((s, o) => s + Number(o.total ?? 0), 0).toFixed(2) + ' NOT RECORDED ***' : 'all recorded'))
  }
  console.log('\n  cash-settled tabs with unpaid orders left on them: ' + unpaidOnCashSettled)

  H('VERDICT')
  const oldStuck = stuck.filter((x) => x.ready_to_pay_at && (now - new Date(x.ready_to_pay_at).getTime()) > 6 * 3600000)
  console.log('  tabs stuck in ready_to_pay:            ' + stuck.length)
  console.log('  of those older than 6 hours:           ' + oldStuck.length +
    (oldStuck.length ? '   <- nobody came, or the customer left' : ''))
  console.log('  money outstanding on stuck tabs:       N$' +
    stuck.reduce((s, x) => s + owed(x.id), 0).toFixed(2))
  console.log('  recovered after ready_to_pay:          ' + settledAfter.length + ' of ' + reached.length)

  console.log('\nCASH_EVICTION_PROBE_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
