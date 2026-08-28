/**
 * PROVE THE RACE: a waiter amends a line at the same moment the kitchen taps it cooked.
 *
 * Ruled: "The kitchen wins and the amendment refuses." This does not assert that in a mock --
 * it fires both writes concurrently against REAL staging Postgres (amend_order_lines() and the
 * exact conditional UPDATE POST /api/station/order-lines/[lineId]/state itself runs), N times,
 * and reports what actually happened each time. The safety property under test is mutual
 * exclusion: a trial where BOTH the amend and the cook bump succeeded on the same line would
 * mean the race is not actually closed, whichever direction "wins" more often.
 *
 * STAGING ONLY, same two-guard shape every other real-staging probe tonight uses.
 * Usage: npx tsx scripts/prod/probe-amend-cook-race-staging.ts
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { nextOrderNumber } from '../../lib/orders/order-number'

config({ path: resolve(__dirname, '../../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
if (!URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL is not staging (${STAGING_REF}). Got: ${URL || '(empty)'}`)
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // 'staging test'
const TRIALS = 20

async function pickFreeTable(): Promise<{ id: string; table_number: number }> {
  const [{ data: tables, error: tablesError }, { data: openTabs, error: openTabsError }] = await Promise.all([
    db.from('restaurant_tables').select('id, table_number').eq('restaurant_id', RESTAURANT_ID),
    db.from('tabs').select('table_id').eq('restaurant_id', RESTAURANT_ID).in('status', ['open', 'ready_to_pay']),
  ])
  if (tablesError) throw tablesError
  if (openTabsError) throw openTabsError

  const occupied = new Set((openTabs ?? []).map((t) => String(t.table_id)))
  const free = (tables ?? []).find((t) => !occupied.has(String(t.id)))
  if (!free) throw new Error('every restaurant_tables row already has an open tab -- nothing free to probe with')
  return free as { id: string; table_number: number }
}

async function makeTrial(n: number) {
  const table = await pickFreeTable()

  const { data: tab, error: tabError } = await db
    .from('tabs')
    .insert({
      restaurant_id: RESTAURANT_ID,
      table_id: table.id,
      table_number: table.table_number,
      status: 'open',
      members: [],
      total: 0,
    })
    .select('id')
    .single()
  if (tabError || !tab?.id) throw new Error(`tab insert failed: ${tabError?.message}`)

  const orderNumber = 800000 + n
  const item = {
    menuItemId: null,
    name: `PROBE amend-race item ${n}`,
    priceSource: 'catalog',
    quantity: 2,
    route_to: 'kitchen',
    subtotal: 20,
    tax: 0,
    taxInclusive: true,
    taxRateId: null,
    taxRatePercentage: 0,
    total: 20,
    unitPrice: 10,
  }

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      firebase_restaurant_id: RESTAURANT_ID,
      tab_id: tab.id,
      table_id: table.id,
      table_number: table.table_number,
      order_number: orderNumber,
      status: 'pending',
      payment_status: 'pending',
      payment_method: 'cash',
      channel: 'pos',
      items: [item],
      subtotal: 20,
      tax: 0,
      total: 20,
      is_closed: false,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (orderError || !order?.id) throw new Error(`order insert failed: ${orderError?.message}`)

  const { data: line, error: lineError } = await db
    .from('order_lines')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_id: order.id,
      tab_id: tab.id,
      source_item_index: 0,
      name_snapshot: item.name,
      quantity: 2,
      route_to: 'kitchen',
      kitchen_state: 'outstanding',
      bar_state: null,
    })
    .select('id')
    .single()
  if (lineError || !line?.id) throw new Error(`line insert failed: ${lineError?.message}`)

  return { tabId: tab.id, lineId: line.id }
}

/** The exact conditional UPDATE app/api/station/order-lines/[lineId]/state/route.ts runs. */
async function cookBump(lineId: string) {
  const { data, error } = await db
    .from('order_lines')
    .update({ kitchen_state: 'cooked' })
    .eq('id', lineId)
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('kitchen_state', 'outstanding')
    .select('id')
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.id)
}

/** Reads a fresh order number the same way the real route does -- see order-number.ts. */
async function amend(tabId: string, lineId: string) {
  const orderNumber = await nextOrderNumber(db, RESTAURANT_ID)
  const { data, error } = await db.rpc('amend_order_lines', {
    p_restaurant_id: RESTAURANT_ID,
    p_tab_id: tabId,
    p_order_number: orderNumber,
    p_actor_kind: 'terminal',
    p_actor_user_id: null,
    p_amendments: [{ line_id: lineId, new_quantity: 5 }],
  })
  if (error) throw error
  const applied = (data.applied ?? []) as Array<{ line_id: string }>
  const refused = (data.refused ?? []) as Array<{ line_id: string; reason: string }>
  return {
    applied: applied.some((a) => a.line_id === lineId),
    refused: refused.find((r) => r.line_id === lineId)?.reason ?? null,
  }
}

/**
 * ONE OPEN TAB PER TABLE at a time (idx_tabs_one_open_per_table), so each trial's tab is torn
 * down before the next trial opens a new one on the same table -- not batched at the end.
 */
async function cleanup(tabIds: string[]) {
  const { data: lines } = await db.from('order_lines').select('id').in('tab_id', tabIds)
  const lineIds = (lines ?? []).map((l) => String(l.id))
  if (lineIds.length) await db.from('order_line_events').delete().in('order_line_id', lineIds)
  await db.from('order_lines').delete().in('tab_id', tabIds)
  await db.from('orders').delete().in('tab_id', tabIds)
  await db.from('tabs').delete().in('id', tabIds)
}

async function main() {
  console.log(`=== PROVING THE RACE against STAGING ${STAGING_REF}, ${TRIALS} trials ===\n`)

  let kitchenWon = 0
  let amendWon = 0
  let bothSucceeded = 0
  let neitherSucceeded = 0

  for (let n = 1; n <= TRIALS; n++) {
    const { tabId, lineId } = await makeTrial(n)
    try {
      const [cookResult, amendResult] = await Promise.all([
        cookBump(lineId),
        amend(tabId, lineId),
      ])

      const cookSucceeded = cookResult === true
      const amendSucceeded = amendResult.applied === true

      if (cookSucceeded && amendSucceeded) {
        bothSucceeded++
        console.error(`  trial ${n}: BOTH SUCCEEDED -- race is NOT closed. cook=${cookSucceeded} amend=${JSON.stringify(amendResult)}`)
      } else if (!cookSucceeded && !amendSucceeded) {
        neitherSucceeded++
        console.error(`  trial ${n}: NEITHER SUCCEEDED -- unexpected. amend refusal: ${amendResult.refused}`)
      } else if (cookSucceeded) {
        kitchenWon++
        console.log(`  trial ${n}: kitchen won, amendment refused (${amendResult.refused})`)
      } else {
        amendWon++
        console.log(`  trial ${n}: amendment won, cook bump found the line already voided`)
      }
    } finally {
      await cleanup([tabId])
    }
  }

  console.log(`\n=== RESULTS over ${TRIALS} trials ===`)
  console.log(`  kitchen won (amend refused):  ${kitchenWon}`)
  console.log(`  amend won (cook bump lost):   ${amendWon}`)
  console.log(`  BOTH succeeded (unsafe):      ${bothSucceeded}`)
  console.log(`  neither succeeded (bug):      ${neitherSucceeded}`)

  if (bothSucceeded > 0 || neitherSucceeded > 0) {
    console.error('\nFAILED: the race is not safely closed. See trials above.')
    process.exit(1)
  }
  if (kitchenWon === 0) {
    console.error('\nINCONCLUSIVE: the kitchen never won a single trial, so "kitchen wins, amendment refuses" was never actually exercised.')
    process.exit(1)
  }
  console.log('\nPROVED: every trial was mutually exclusive, and the kitchen won at least once.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
