#!/usr/bin/env node
/**
 * THE SHAPE OF PRODUCTION — the distributions a production-shaped fixture has to match.
 *
 * ============================================================================================
 * WHY THIS IS A COMMITTED SCRIPT AND NOT A ONE-OFF QUERY
 * ============================================================================================
 *
 * On 2026-09-01 a live end-to-end verification passed every hop and could not have caught the
 * defect reported hours later, because its fixture used single-station lines while 13 of the 13
 * order_lines in production were `both`. The fixture was the one shape that did not exist in
 * production, chosen because it made each assertion clean.
 *
 * A fixture is not representative because it is convenient. It is representative when its
 * distribution matches the rows. So this prints the distribution, it is re-runnable, and
 * `__tests__/e2e-order-to-receipt.test.ts` quotes its output with the date it was taken — which
 * means a fixture that drifts back to convenient can be SEEN to have drifted rather than argued
 * about.
 *
 * READ-ONLY. No writes. Nothing here charges anything.
 *
 * Usage: node scripts/reports/production-shape-report.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp2/Tap-n-Munch/.env.local'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
if (!String(env.NEXT_PUBLIC_SUPABASE_URL || '').includes(PRODUCTION_REF)) {
  throw new Error('refusing to run: this is not the production project')
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/** Every row. A bare select caps at 1000, and a capped read's zeros mean nothing. */
async function all(table, cols) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}
async function exact(table) {
  const { count, error } = await db.from(table).select('id', { count: 'exact', head: true })
  if (error) throw new Error(`${table}: ${error.message}`)
  return count
}
const tally = (rows, key) => {
  const out = {}
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key]
    out[String(k)] = (out[String(k)] ?? 0) + 1
  }
  return out
}

console.log(`PRODUCTION SHAPE — ${new Date().toISOString().slice(0, 10)}, read-only\n`)

// ── routing ──────────────────────────────────────────────────────────────────

const categories = await all('menu_categories', 'id,restaurant_id,name,route_to')
const items = await all('menu_items', 'id,restaurant_id,name,category_id,status,track_inventory')
const catById = Object.fromEntries(categories.map((c) => [c.id, c]))

console.log('CATEGORIES by route_to')
console.log(' ', JSON.stringify(tally(categories, 'route_to')))

console.log('\nMENU ITEMS by the route their category gives them')
const itemRoute = (i) => {
  const c = i.category_id ? catById[i.category_id] : null
  const r = c?.route_to
  return r === 'kitchen' || r === 'bar' || r === 'both' ? r : 'unrouted'
}
console.log(' ', JSON.stringify(tally(items, itemRoute)))

console.log('\nMENU ITEMS by status (what is orderable at all)')
console.log(' ', JSON.stringify(tally(items, 'status')))

// ── inventory backing ────────────────────────────────────────────────────────

const recipes = await all('recipes', 'id,menu_item_id,is_active,deleted_at')
const recipeItems = await all('recipe_items', 'recipe_id')
const liveRecipe = new Set()
for (const r of recipes) {
  if (r.is_active !== true || r.deleted_at) continue
  if (recipeItems.some((ri) => ri.recipe_id === r.id)) liveRecipe.add(r.menu_item_id)
}
console.log('\nMENU ITEMS by inventory configuration')
console.log(
  ' ',
  JSON.stringify(
    tally(items, (i) => {
      const tracked = i.track_inventory === true
      const backed = liveRecipe.has(i.id)
      if (tracked && backed) return 'deducting'
      if (tracked && !backed) return 'tracked_without_recipe'
      if (!tracked && backed) return 'recipe_without_tracking'
      return 'not_tracked'
    }),
  ),
)

// ── order lines and station states ───────────────────────────────────────────

const lines = await all('order_lines', 'id,route_to,kitchen_state,bar_state')
console.log(`\nORDER LINES: ${lines.length} (exact ${await exact('order_lines')})`)
console.log('  by route_to     :', JSON.stringify(tally(lines, 'route_to')))
console.log('  kitchen_state   :', JSON.stringify(tally(lines, (l) => l.kitchen_state)))
console.log('  bar_state       :', JSON.stringify(tally(lines, (l) => l.bar_state)))

const bothLines = lines.filter((l) => l.route_to === 'both')
const finished = (s) => s === 'ready' || s === 'collected'
console.log(`  'both' lines    : ${bothLines.length}`)
console.log(
  '    of those, PARTIAL (exactly one station finished):',
  bothLines.filter((l) => finished(l.kitchen_state) !== finished(l.bar_state)).length,
)
console.log(
  '    both finished                                  :',
  bothLines.filter((l) => finished(l.kitchen_state) && finished(l.bar_state)).length,
)
console.log(
  '    neither finished                               :',
  bothLines.filter((l) => !finished(l.kitchen_state) && !finished(l.bar_state)).length,
)

// ── payment shapes ───────────────────────────────────────────────────────────

const orders = await all('orders', 'id,status,payment_status,payment_method,channel,total,is_stress_fixture')
const real = orders.filter((o) => !o.is_stress_fixture)
console.log(`\nORDERS: ${orders.length} total, ${real.length} excluding stress fixtures`)
console.log('  status/payment  :', JSON.stringify(tally(real, (o) => `${o.status}/${o.payment_status}`)))
console.log('  payment_method  :', JSON.stringify(tally(real, 'payment_method')))
console.log('  channel         :', JSON.stringify(tally(real, 'channel')))

const events = await all('payment_events', 'id,event_type,order_ids')
console.log(`\nPAYMENT EVENTS: ${events.length}`)
console.log('  by type         :', JSON.stringify(tally(events, 'event_type')))
console.log(
  '  covering >1 order:',
  events.filter((e) => Array.isArray(e.order_ids) && e.order_ids.length > 1).length,
)

const receipts = await all('receipt_documents', 'id,snapshot_json')
let reconciling = 0
let vatCharged = 0
for (const d of receipts) {
  const s = d.snapshot_json
  const paid = (s?.payments ?? []).reduce((a, p) => a + Math.round(Number(p.amount || 0) * 100), 0)
  if (paid === Math.round(Number(s?.totals?.grand_total || 0) * 100)) reconciling++
  if (Number(s?.totals?.vat || 0) > 0) vatCharged++
}
console.log(`\nRECEIPTS: ${receipts.length}`)
console.log(`  payments == grand_total : ${reconciling}`)
console.log(`  charged VAT             : ${vatCharged}`)

console.log('\nA FIXTURE MUST COVER, AT MINIMUM:')
console.log('  kitchen-only, bar-only, and genuine `both` lines — `both` being the majority shape')
console.log('  a PARTIAL both line (one station finished, one not)')
console.log('  an inventory-backed item AND a non-inventory item')
console.log('  a single-order settlement (no multi-order payment event exists yet)')
