// @ts-nocheck
/**
 * READ ONLY. #347 — HOW MANY PRODUCTION ORDERS ASSERT A PAYMENT THAT HAS NO EVIDENCE?
 *
 * Ruled 2026-08-26: run the sweep first, correct nothing. This decides whether #347 is a footnote
 * about three test-account rows or a revenue reconciliation across the live venues.
 *
 * ============================================================================================
 * THE SIGNATURE, AND WHY IT IS NOT ENOUGH ON ITS OWN
 * ============================================================================================
 *
 * Before `50f826f6` (2026-07-30) Close Table bulk-wrote
 * `status='completed', payment_status='paid', paid_at=now, completed_at=now`
 * on every open order at a table, with no payment guard. Its fingerprint is `paid_at == completed_at`
 * to the millisecond, usually shared across several orders at once.
 *
 * THAT FINGERPRINT ALONE PROVES NOTHING. `reconcileOrphanPayments` writes the same four fields in
 * one statement, and so does a legitimate tab settle. 1852 of production's 1865 orders carrying a
 * paid_at have `paid_at == completed_at`, so a sweep on that alone would indict nearly the whole
 * table.
 *
 * WHAT ACTUALLY SEPARATES THEM IS EVIDENCE OF MONEY, not the shape of the write:
 *
 *   a `payments` row                    the gateway settled it
 *   a `payment_events` sale row         the terminal recorded a sale
 *   a gateway reference on the order    txn id / trans no / voucher / merchant order no
 *
 * An order marked paid carrying NONE of those is the class #347 is about. Everything else is a
 * timestamp question, not a money question.
 *
 * ============================================================================================
 * THE CONTROLS, BECAUSE "NOTHING FOUND" IS THE ANSWER THAT GETS SHIPPED UNCHECKED
 * ============================================================================================
 *
 *   1. The three known rows (Digi Cofee #1, #2, #6) MUST appear. If the query cannot find the
 *      cases we already proved by hand, its zero for everything else means nothing.
 *   2. Orders WITH evidence are counted too, so a filter that matched nothing is distinguishable
 *      from a population that is clean.
 *   3. Split at 2026-07-30. The fix landed then, so the post-fix count should be ~0 — and if it is
 *      not, the fix did not hold and that is a bigger finding than the backlog.
 *   4. Stress fixtures excluded via the shared helper, or 1314 zero-total rows drown the result.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const FIX_LANDED = '2026-07-30T00:00:00.000Z'
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
    const { data, error } = await db.from('orders')
      .select('id,restaurant_id,firebase_restaurant_id,order_number,table_number,tab_id,channel,' +
        'payment_method,payment_status,status,total,placed_at,paid_at,completed_at,' +
        'paycloud_merchant_order_no,paycloud_transaction_id,payment_trans_no,payment_voucher_no,payment_reference')
      .order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const pays = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('payments').select('id,order_ids,amount,method,status').range(f, f + 999)
    if (error) { console.log('payments ERROR ' + error.message); break }
    pays.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const events = []
  {
    const { data, error } = await db.from('payment_events').select('id,order_ids,event_type,amount').limit(5000)
    if (error) console.log('payment_events ERROR ' + error.message)
    else events.push(...(data ?? []))
  }

  const paidOrderIds = new Set()
  for (const p of pays) for (const o of (p.order_ids ?? [])) paidOrderIds.add(String(o))
  const eventOrderIds = new Set()
  for (const e of events) if (e.event_type === 'sale') for (const o of (e.order_ids ?? [])) eventOrderIds.add(String(o))

  const has = (o, k) => { const v = o[k]; return v !== null && v !== undefined && String(v).trim() !== '' }
  const hasGatewayRef = (o) =>
    has(o, 'paycloud_transaction_id') || has(o, 'payment_trans_no') ||
    has(o, 'payment_voucher_no') || has(o, 'paycloud_merchant_order_no') || has(o, 'payment_reference')
  const hasEvidence = (o) =>
    paidOrderIds.has(String(o.id)) || eventOrderIds.has(String(o.id)) || hasGatewayRef(o)

  const real = rows.filter((o) => !isStressFixtureOrder(o))
  const paid = real.filter((o) => o.payment_status === 'paid')

  H('1. THE POPULATION')
  console.log('  orders read                 ' + rows.length)
  console.log('  stress fixtures excluded    ' + (rows.length - real.length))
  console.log('  real orders                 ' + real.length)
  console.log('  marked paid                 ' + paid.length)
  console.log('  payments rows               ' + pays.length + '   sale events ' + events.filter((e) => e.event_type === 'sale').length)

  H('2. PAID WITH NO EVIDENCE OF MONEY')
  const allNoEvidence = paid.filter((o) => !hasEvidence(o))
  const withEvidence = paid.filter(hasEvidence)
  console.log('  paid WITH evidence          ' + withEvidence.length + '   <- control: the filter is not matching everything')
  console.log('  paid with NO evidence       ' + allNoEvidence.length)

  /*
   * CASH IS SPLIT OUT, AND NOT AS A CONVENIENCE. A cash order has no gateway reference, no
   * `payments` row and no sale event BY CONSTRUCTION -- the money is handed over and staff record
   * it. "No evidence of a gateway payment" is the expected state for cash, not a defect, and
   * counting it here would have reported 18 findings where the real number is 4.
   *
   * #347 is about an order asserting a CARD payment that no gateway ever saw. That is the cut.
   */
  const isCash = (o) => String(o.payment_method ?? '').toLowerCase().startsWith('cash')
  const cashNoEvidence = allNoEvidence.filter(isCash)
  const noEvidence = allNoEvidence.filter((o) => !isCash(o))
  console.log('')
  console.log('  of those, CASH              ' + cashNoEvidence.length + '   expected: cash has no gateway record by construction')
  console.log('  of those, CARD              ' + noEvidence.length + '   <- the class #347 is about')

  const before = noEvidence.filter((o) => String(o.placed_at) < FIX_LANDED)
  const after = noEvidence.filter((o) => String(o.placed_at) >= FIX_LANDED)
  console.log('\n  placed BEFORE 2026-07-30 (pre-50f826f6)   ' + before.length)
  console.log('  placed AFTER  2026-07-30 (post-fix)       ' + after.length +
    (after.length === 0 ? '   <- the fix held' : '   *** THE FIX DID NOT HOLD — investigate these first ***'))

  const byVenue = new Map()
  for (const o of noEvidence) {
    const k = vname.get(o.restaurant_id) ?? String(o.restaurant_id)
    if (!byVenue.has(k)) byVenue.set(k, [])
    byVenue.get(k).push(o)
  }
  console.log('\n  by venue:')
  for (const [v, list] of [...byVenue].sort((a, b) => b[1].length - a[1].length)) {
    const sum = list.reduce((s, o) => s + Number(o.total ?? 0), 0)
    console.log('    ' + pad(v, 24) + String(list.length).padStart(4) + ' order(s)   N$' + sum.toFixed(2))
  }

  H('3. THE CONTROL — the three rows we already proved by hand must appear')
  const known = ['Digi Cofee|1', 'Digi Cofee|2', 'Digi Cofee|6']
  for (const k of known) {
    const [venue, num] = k.split('|')
    const hit = noEvidence.find((o) => (vname.get(o.restaurant_id) ?? '') === venue && String(o.order_number) === num)
    console.log('  ' + pad(venue + ' #' + num, 20) + (hit ? 'FOUND — the sweep can see the known cases' : '*** MISSING — the sweep is blind, ignore its zero ***'))
  }

  H('4. EVERY NO-EVIDENCE CARD ORDER, oldest first')
  console.log('  ' + pad('venue', 20) + pad('#', 7) + pad('N$', 9) + pad('method', 8) + pad('chan', 7) +
    pad('placed', 18) + pad('paid_at', 18) + 'paid==completed  gap')
  for (const o of noEvidence.sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)))) {
    const same = o.paid_at && o.completed_at && o.paid_at === o.completed_at
    const gapMin = o.paid_at && o.placed_at
      ? ((new Date(o.paid_at).getTime() - new Date(o.placed_at).getTime()) / 60000) : null
    console.log('  ' + pad(vname.get(o.restaurant_id) ?? '?', 20) + pad('#' + o.order_number, 7) +
      pad(Number(o.total ?? 0).toFixed(2), 9) + pad(o.payment_method, 8) + pad(o.channel, 7) +
      pad(t(o.placed_at), 18) + pad(t(o.paid_at), 18) +
      pad(same ? 'yes' : 'no', 17) +
      (gapMin === null ? '-' : gapMin > 1440 ? (gapMin / 1440).toFixed(1) + 'd' : gapMin.toFixed(0) + 'm'))
  }

  H('5. SHARED-INSTANT BATCHES among them — one Close Table press, several orders')
  const byInstant = new Map()
  for (const o of noEvidence.filter((o) => o.paid_at)) {
    const k = String(o.paid_at)
    if (!byInstant.has(k)) byInstant.set(k, [])
    byInstant.get(k).push(o)
  }
  const shared = [...byInstant].filter(([, l]) => l.length > 1)
  console.log('  instants shared by more than one no-evidence order: ' + shared.length)
  for (const [k, list] of shared.sort()) {
    console.log('    ' + t(k) + '  x' + list.length + '  ' + pad(vname.get(list[0].restaurant_id) ?? '?', 16) +
      list.map((o) => '#' + o.order_number + ' N$' + o.total).join('  '))
  }

  H('VERDICT')
  const sum = noEvidence.reduce((s, o) => s + Number(o.total ?? 0), 0)
  const liveVenues = [...byVenue.keys()].filter((v) => v !== 'Digi Cofee' && v !== 'Riviera')
  console.log('  CARD orders asserting a payment no gateway saw: ' + noEvidence.length +
    ', N$' + sum.toFixed(2) + ', across ' + byVenue.size + ' venue(s).')
  console.log('  (' + cashNoEvidence.length + ' cash orders excluded — no gateway record is correct for cash.)')
  console.log('  Venues that are NOT test accounts: ' + (liveVenues.length ? liveVenues.join(', ') : 'NONE'))
  console.log('')
  console.log(liveVenues.length === 0
    ? '  FOOTNOTE. Every affected CARD order is on a test account. #347 is a record of the mechanism.'
    : [
        '  Live venue(s) affected — read section 4 before calling it a reconciliation.',
        '  The Close Table signature is paid_at == completed_at in a SHARED instant. An order',
        '  without that shape got here by a different route and is a different question.',
      ].join('\n'))

  console.log('\nSWEEP_347_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
