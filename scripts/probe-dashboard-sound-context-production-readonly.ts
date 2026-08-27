/**
 * SOUND ALERT FOR INCOMING ORDERS — the two questions that must be measured before building.
 *
 * Strictly read-only. Selects only; no insert, update, delete or rpc. Production is not a test
 * environment.
 *
 *   Q1  Which realtime event actually fires on a new customer order, and do BOTH
 *       `order_requests` and `orders` need handling?
 *
 *       Answered from the data rather than from the routes: if QR customer orders arrive as
 *       order_requests first and become orders on staff Accept, then a single order produces TWO
 *       inserts and the dashboard that accepted it would sound twice. `source_request_id` on
 *       `orders` is the link that proves it.
 *
 *   Q2  Is the dashboard ever open on more than one screen at a venue?
 *
 *       There is no presence tracking, so this cannot be answered directly. What CAN be measured
 *       is the upper bound: how many staff accounts could open it per restaurant. One account is
 *       proof it cannot double-sound across people; several is not proof that it does, and the
 *       report must say which of those it is rather than inventing a number.
 */
/**
 * #324 — the Q1 sample now excludes the stress fixtures.
 *
 * It reads the 1,000 most recent orders and reports a by-channel distribution. Measured
 * read-only on production 2026-08-27 that window happens to contain ZERO fixtures: the 1,314
 * seeded rows were placed 2026-04-27..2026-06-16 and real trade has since pushed them past
 * position 1,000. So this file was reporting a correct distribution FOR THE WRONG REASON — it was
 * saved by an ORDER BY, and the day the sample widens or trade slows it stops being saved.
 *
 * Note what a fixture would have done to THIS question specifically: all 1,314 carry
 * `channel = 'table'`, which is the exact bucket Q1 is asking about.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { excludeStressFixtures } from '../lib/orders/stress-fixtures'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log('\nPRODUCTION — context for the dashboard sound alert, read-only\n')

  const { data: ctl, error: ctlErr } = await admin.from('orders').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] orders readable and non-empty : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ---------------------------------------------------------------- Q1
  console.log('\n  Q1  WHICH TABLE DOES A NEW CUSTOMER ORDER LAND IN?\n')

  const { data: orders, error: oErr } = await excludeStressFixtures(
    admin
      .from('orders')
      .select('id, channel, status, source_request_id, placed_at')
      .order('placed_at', { ascending: false })
      .limit(1000),
  )
  if (oErr) throw new Error(`orders read: ${oErr.message}`)

  const byChannel = new Map<string, number>()
  let withSource = 0
  for (const o of orders ?? []) {
    const ch = String(o.channel ?? '(null)')
    byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1)
    if (o.source_request_id) withSource++
  }
  console.log(`  orders sampled                          : ${orders?.length ?? 0}`)
  console.log('  by channel:')
  for (const [ch, n] of [...byChannel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${ch.padEnd(14)} ${n}`)
  }
  console.log(`  carrying source_request_id              : ${withSource}`)
  console.log('    ^ each of these was an order_request FIRST, so it produced TWO realtime inserts')

  const { count: reqTotal } = await admin
    .from('order_requests')
    .select('id', { count: 'exact', head: true })
  console.log(`  order_requests rows total               : ${reqTotal}`)

  const { data: reqStatuses } = await admin.from('order_requests').select('status, channel').limit(1000)
  const reqByStatus = new Map<string, number>()
  const reqByChannel = new Map<string, number>()
  for (const r of reqStatuses ?? []) {
    reqByStatus.set(String(r.status), (reqByStatus.get(String(r.status)) ?? 0) + 1)
    reqByChannel.set(String(r.channel ?? '(null)'), (reqByChannel.get(String(r.channel ?? '(null)')) ?? 0) + 1)
  }
  console.log('  order_requests by status:')
  for (const [s, n] of reqByStatus) console.log(`      ${s.padEnd(16)} ${n}`)
  console.log('  order_requests by channel:')
  for (const [c, n] of reqByChannel) console.log(`      ${c.padEnd(16)} ${n}`)

  /**
   * The double-sound, stated as data. The dashboard sounds on `orders` INSERT when
   * status === 'pending', and createOrder() writes status 'pending' — including when it is called
   * by the Accept route. So an accepted request sounds a SECOND time on the very dashboard that
   * accepted it.
   */
  const acceptedNowPending = (orders ?? []).filter(
    (o) => o.source_request_id && String(o.status).toLowerCase() === 'pending',
  ).length
  console.log(`\n  orders that came from a request AND are still 'pending' : ${acceptedNowPending}`)
  console.log("    ^ the dashboard's orders-INSERT branch fires on status === 'pending'")

  // ---------------------------------------------------------------- Q2
  console.log('\n  Q2  COULD THE DASHBOARD BE OPEN ON MORE THAN ONE SCREEN?\n')
  console.log('  No presence tracking exists, so this is an UPPER BOUND, not an observation.')

  const { data: members, error: mErr } = await admin
    .from('restaurant_users')
    .select('restaurant_id, user_id, role, deleted_at')
  if (mErr) throw new Error(`restaurant_users read: ${mErr.message}`)

  const live = (members ?? []).filter((m) => !m.deleted_at)
  const perRestaurant = new Map<string, number>()
  for (const m of live) {
    perRestaurant.set(String(m.restaurant_id), (perRestaurant.get(String(m.restaurant_id)) ?? 0) + 1)
  }

  const { data: restaurants } = await admin.from('restaurants').select('id, name')
  const nameById = new Map((restaurants ?? []).map((r) => [String(r.id), String(r.name)]))

  console.log(`  restaurants with at least one staff account : ${perRestaurant.size}`)
  const rows = [...perRestaurant.entries()].sort((a, b) => b[1] - a[1])
  for (const [rid, n] of rows) {
    console.log(`      ${String(nameById.get(rid) ?? rid).padEnd(28)} ${n} staff account${n === 1 ? '' : 's'}`)
  }
  const multi = rows.filter(([, n]) => n > 1).length
  console.log(`\n  restaurants where >1 account could open it  : ${multi} of ${rows.length}`)
  console.log('    ^ an upper bound on concurrent dashboards. It does NOT establish that two are')
  console.log('      ever open at once — only that the single-screen assumption cannot be relied on.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
