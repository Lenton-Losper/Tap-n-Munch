#!/usr/bin/env node
/**
 * MERCHANT CONFIGURATION REVIEW — the two lists a merchant has to act on.
 *
 *   1. Every menu item routed `both`, grouped by venue and category.
 *      Ruled 2026-09-01: these are NOT to be changed automatically. `both` is legitimate — a
 *      sharing platter really is made in two places — so the system produces a review, and a human
 *      decides. What made it dangerous was never the value; it was that nothing said what it costs.
 *
 *   2. Every menu item flagged "track inventory" with no usable recipe.
 *      Ruled 2026-09-01: incomplete configuration is never guessed at. It is excluded from
 *      automatic deduction and surfaced. Inferring ingredients from a name or a price would put
 *      invented numbers into a ledger people count stock against.
 *
 * READ-ONLY. No writes of any kind. Nothing here changes a single row.
 *
 * Usage:
 *   node scripts/reports/merchant-configuration-report.mjs            # human-readable
 *   node scripts/reports/merchant-configuration-report.mjs --csv      # csv, for sending on
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp2/Tap-n-Munch/.env.local'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const asCsv = process.argv.includes('--csv')

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

/** Reads EVERY row. A bare select caps at 1000 and its totals are then silently wrong. */
async function all(table, cols) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const restaurants = await all('restaurants', 'id,name')
const categories = await all('menu_categories', 'id,restaurant_id,name,route_to,active')
const items = await all('menu_items', 'id,restaurant_id,name,category_id,status,track_inventory')
const recipes = await all('recipes', 'id,restaurant_id,menu_item_id,is_active,deleted_at')
const recipeItems = await all('recipe_items', 'recipe_id,stock_item_id,quantity')

if (!restaurants.length || !items.length) {
  throw new Error('read zero venues or zero menu items — the report is broken, not the data')
}

const venue = Object.fromEntries(restaurants.map((r) => [r.id, r.name]))
const categoryById = Object.fromEntries(categories.map((c) => [c.id, c]))

// ── report 1: route_to = 'both' ──────────────────────────────────────────────

const bothItems = items
  .filter((i) => i.category_id && categoryById[i.category_id]?.route_to === 'both')
  .map((i) => ({
    venue: venue[i.restaurant_id] ?? '(unknown venue)',
    category: categoryById[i.category_id].name,
    categoryActive: categoryById[i.category_id].active !== false,
    item: i.name,
    status: i.status ?? 'null',
    // 'hidden' items cannot be ordered, so they cannot produce a stuck line today.
    orderable: ['available', 'active'].includes(String(i.status)),
  }))

// ── report 2: tracked, no usable recipe ──────────────────────────────────────

const liveRecipeByItem = {}
for (const r of recipes) {
  if (r.is_active !== true || r.deleted_at) continue
  const ingredients = recipeItems.filter((ri) => ri.recipe_id === r.id).length
  // An EMPTY recipe deducts nothing, so it is not configuration.
  if (ingredients >= 1) liveRecipeByItem[r.menu_item_id] = ingredients
}

const trackedNoRecipe = items
  .filter((i) => i.track_inventory === true && !liveRecipeByItem[i.id])
  .map((i) => ({
    venue: venue[i.restaurant_id] ?? '(unknown venue)',
    category: i.category_id ? (categoryById[i.category_id]?.name ?? '(no category)') : '(no category)',
    item: i.name,
    status: i.status ?? 'null',
    orderable: ['available', 'active'].includes(String(i.status)),
  }))

const recipeNoTracking = items.filter(
  (i) => i.track_inventory !== true && liveRecipeByItem[i.id],
).length

// ── output ───────────────────────────────────────────────────────────────────

if (asCsv) {
  console.log('report,venue,category,item,status,orderable')
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
  for (const r of bothItems) {
    console.log(['route_to_both', r.venue, r.category, r.item, r.status, r.orderable].map(esc).join(','))
  }
  for (const r of trackedNoRecipe) {
    console.log(
      ['tracked_without_recipe', r.venue, r.category, r.item, r.status, r.orderable].map(esc).join(','),
    )
  }
} else {
  const group = (rows) => {
    const out = {}
    for (const r of rows) ((out[r.venue] ??= {})[r.category] ??= []).push(r)
    return out
  }

  console.log('MERCHANT CONFIGURATION REVIEW — production, read-only')
  console.log(`${restaurants.length} venues, ${items.length} menu items, ${categories.length} categories.\n`)

  console.log('='.repeat(78))
  console.log(`1. ITEMS ROUTED TO BOTH STATIONS — ${bothItems.length} items`)
  console.log('='.repeat(78))
  console.log('Both means the KITCHEN and the BAR must EACH finish the item before it becomes')
  console.log('Ready. One station finishing is not enough. Nothing here has been changed.\n')
  const g1 = group(bothItems)
  for (const [v, cats] of Object.entries(g1).sort()) {
    const n = Object.values(cats).flat().length
    console.log(`  ${v}  (${n} item${n === 1 ? '' : 's'})`)
    for (const [c, rows] of Object.entries(cats).sort()) {
      const orderable = rows.filter((r) => r.orderable).length
      console.log(`    ${c} — ${rows.length} item${rows.length === 1 ? '' : 's'}, ${orderable} orderable`)
      for (const r of rows.sort((a, b) => a.item.localeCompare(b.item))) {
        console.log(`        ${r.orderable ? '•' : '·'} ${r.item}${r.orderable ? '' : `  (${r.status}, not orderable)`}`)
      }
    }
    console.log()
  }
  const orderableBoth = bothItems.filter((r) => r.orderable).length
  console.log(`  ${orderableBoth} of ${bothItems.length} can be ordered today; each will produce a line`)
  console.log('  that no single station can release.\n')

  console.log('='.repeat(78))
  console.log(`2. TRACKED WITH NO USABLE RECIPE — ${trackedNoRecipe.length} items`)
  console.log('='.repeat(78))
  console.log('Every screen says these are tracked. Nothing is deducted when they sell, and')
  console.log('nothing will be until a recipe is configured. They are excluded from automatic')
  console.log('deduction on purpose — ingredients are never guessed.\n')
  const g2 = group(trackedNoRecipe)
  for (const [v, cats] of Object.entries(g2).sort()) {
    const n = Object.values(cats).flat().length
    console.log(`  ${v}  (${n} item${n === 1 ? '' : 's'})`)
    for (const [c, rows] of Object.entries(cats).sort()) {
      console.log(`    ${c} — ${rows.length}`)
      for (const r of rows.sort((a, b) => a.item.localeCompare(b.item))) {
        console.log(`        ${r.orderable ? '•' : '·'} ${r.item}`)
      }
    }
    console.log()
  }
  console.log(`  Also: ${recipeNoTracking} items have a live recipe but are NOT flagged tracked.`)
  console.log('  Those are dormant by design and need no action.\n')

  console.log('Each merchant chooses per item: configure it, or untick tracking.')
  console.log('Nothing in this report has been changed by running it.')
}
