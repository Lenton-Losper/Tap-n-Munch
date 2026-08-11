/**
 * #106 — measure how many menu items are in the track_inventory desync state.
 *
 * READ-ONLY. Every call below is .select(). No insert, update, delete or rpc.
 * STAGING ONLY — refuses on the production ref, and refuses unless the URL is staging.
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
}
if (!URL.includes(STAGING_REF)) {
  throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${URL}`)
}
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  console.log(`=== #106 track_inventory desync measurement — STAGING ${STAGING_REF} (read-only) ===\n`)

  // Live recipes only: active and not tombstoned, matching every read path
  // (getInventorySetupOverview, check-stock-sufficiency, deduct_recipe_stock).
  const { data: recipes, error: recipesError } = await db
    .from('recipes')
    .select('id, menu_item_id, restaurant_id')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (recipesError) throw recipesError

  const recipeIds = (recipes ?? []).map((r) => String(r.id))
  console.log(`active, non-tombstoned recipes: ${recipeIds.length}`)

  const countByRecipe = new Map<string, number>()
  for (let i = 0; i < recipeIds.length; i += 200) {
    const chunk = recipeIds.slice(i, i + 200)
    if (chunk.length === 0) break
    const { data: items, error: itemsError } = await db
      .from('recipe_items')
      .select('recipe_id')
      .in('recipe_id', chunk)
    if (itemsError) throw itemsError
    for (const row of items ?? []) {
      const id = String(row.recipe_id)
      countByRecipe.set(id, (countByRecipe.get(id) ?? 0) + 1)
    }
  }

  const complete = (recipes ?? []).filter((r) => (countByRecipe.get(String(r.id)) ?? 0) >= 1)
  console.log(`  ...of which have >=1 ingredient: ${complete.length}`)

  const menuItemIds = [...new Set(complete.map((r) => String(r.menu_item_id)))]
  const itemById = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < menuItemIds.length; i += 200) {
    const chunk = menuItemIds.slice(i, i + 200)
    if (chunk.length === 0) break
    const { data: items, error: itemsError } = await db
      .from('menu_items')
      .select('id, name, restaurant_id, track_inventory, status')
      .in('id', chunk)
    if (itemsError) throw itemsError
    for (const row of items ?? []) itemById.set(String(row.id), row)
  }

  // DIRECTION A — the desync #106 is about: a complete, live recipe whose menu item is not
  // flagged as tracked. Invisible to getInventorySetupOverview (both buckets), skipped by
  // deduct_recipe_stock, skipped by check-stock-sufficiency.
  const desynced: Record<string, unknown>[] = []
  let missingMenuItem = 0
  for (const id of menuItemIds) {
    const item = itemById.get(id)
    if (!item) {
      missingMenuItem += 1
      continue
    }
    if (item.track_inventory !== true) desynced.push(item)
  }

  console.log(`\nDIRECTION A — complete live recipe, track_inventory NOT true: ${desynced.length}`)
  for (const item of desynced) {
    console.log(
      `  ${item.id}  track_inventory=${JSON.stringify(item.track_inventory)}  status=${item.status}  ${item.name}  (restaurant ${item.restaurant_id})`,
    )
  }
  if (missingMenuItem > 0) {
    console.log(`  (${missingMenuItem} recipe(s) point at a menu_item row that no longer exists)`)
  }

  // DIRECTION B — tracked but not configured. Modelled deliberately as missingItems, so this is
  // expected and is NOT the defect. Counted only to show A is not just "everything is odd".
  const { data: tracked, error: trackedError } = await db
    .from('menu_items')
    .select('id, name, restaurant_id, status')
    .eq('track_inventory', true)
  if (trackedError) throw trackedError

  const completeMenuItemIds = new Set(menuItemIds)
  const trackedNotConfigured = (tracked ?? []).filter((m) => !completeMenuItemIds.has(String(m.id)))

  console.log(`\nmenu items with track_inventory=true: ${(tracked ?? []).length}`)
  console.log(
    `DIRECTION B — tracked but no complete recipe (expected 'missing' bucket): ${trackedNotConfigured.length}`,
  )

  console.log(`\n=== read-only, nothing written ===`)
}

main().catch((e) => {
  console.error('measurement failed:', e)
  process.exit(1)
})
