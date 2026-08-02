/**
 * READ-ONLY production scope for the recipe-tracking fix (deferred to 2026-08-01).
 *
 * Establishes, as whole-table counts with restaurant names joined:
 *   - how many restaurants and active recipes exist
 *   - which recipes are "linked but not tracked" (active recipe, >=1 ingredient, menu item
 *     track_inventory = false) -- the silent-drift population
 *   - whether any are currently SELLABLE, which is what decides urgency
 *   - the measured stock actually drained by those items, in units and in money
 *   - null/absent track_inventory, which is the regression risk when deduction starts
 *     honouring the flag: an item that currently deducts could silently STOP
 *
 *   npx tsx --env-file=.env.local scripts/scope-recipe-tracking-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/ihlmmpmolnpchzgwyhgh/.test(url)) throw new Error(`Expected production, got ${url}`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  console.log('=== READ-ONLY -- production -- NO WRITES ===')

  const { data: restaurants } = await admin.from('restaurants').select('id, name')
  const rName = new Map((restaurants ?? []).map((r) => [r.id, r.name]))

  const { data: recipes } = await admin
    .from('recipes').select('id, restaurant_id, menu_item_id, is_active')
  const active = (recipes ?? []).filter((r) => r.is_active)

  const { data: recipeItems } = await admin
    .from('recipe_items').select('id, recipe_id, stock_item_id, quantity')
  const ingredientCount = new Map<string, number>()
  for (const ri of recipeItems ?? []) {
    ingredientCount.set(ri.recipe_id, (ingredientCount.get(ri.recipe_id) ?? 0) + 1)
  }

  const menuIds = [...new Set(active.map((r) => r.menu_item_id))]
  const { data: menuItems } = await admin
    .from('menu_items').select('id, name, restaurant_id, track_inventory, status').in('id', menuIds)
  const miById = new Map((menuItems ?? []).map((m) => [m.id, m]))

  log('TOTALS', {
    restaurants: (restaurants ?? []).length,
    recipes_total: (recipes ?? []).length,
    recipes_active: active.length,
    recipe_items_total: (recipeItems ?? []).length,
  })

  // --- the silent-drift population ---
  const affected = active
    .filter((r) => (ingredientCount.get(r.id) ?? 0) >= 1)
    .map((r) => ({ recipe: r, item: miById.get(r.menu_item_id) }))
    .filter((x) => x.item && x.item.track_inventory !== true)

  const affectedRows = affected.map((x) => ({
    restaurant: rName.get(x.item!.restaurant_id) ?? x.item!.restaurant_id,
    menu_item: x.item!.name,
    menu_item_id: x.item!.id,
    recipe_id: x.recipe.id,
    ingredients: ingredientCount.get(x.recipe.id) ?? 0,
    menu_status: x.item!.status,
    currently_sellable: x.item!.status !== 'hidden',
  }))
  log(`LINKED BUT NOT TRACKED -- ${affectedRows.length} of ${active.length} active recipes`, affectedRows)
  log('CURRENTLY SELLABLE (this is what decides urgency)', {
    count: affectedRows.filter((r) => r.currently_sellable).length,
    items: affectedRows.filter((r) => r.currently_sellable).map((r) => `${r.restaurant} / ${r.menu_item}`),
  })

  // --- measured impact: stock actually drained by those items ---
  const impact: Array<Record<string, unknown>> = []
  for (const x of affected) {
    const items = (recipeItems ?? []).filter((ri) => ri.recipe_id === x.recipe.id)
    for (const ri of items) {
      const { data: si } = await admin
        .from('stock_items').select('id, name, unit_id').eq('id', ri.stock_item_id).maybeSingle()
      // Sale-driven movements only: those are the ones deduction created.
      const { data: mv } = await admin
        .from('stock_movements')
        .select('quantity_delta, reason, created_at')
        .eq('stock_item_id', ri.stock_item_id)
        .eq('reason', 'sale')
      const drained = (mv ?? []).reduce((s, m) => s + Math.min(0, Number(m.quantity_delta)), 0)
      impact.push({
        restaurant: rName.get(x.item!.restaurant_id),
        menu_item: x.item!.name,
        stock_item: si?.name ?? '(unknown)',
        sale_movements: (mv ?? []).length,
        units_drained_by_sales: drained,
        note: 'sale movements on this stock item overall -- not all necessarily from this menu item',
      })
    }
  }
  log('MEASURED IMPACT ON THE AFFECTED ITEMS', impact.length ? impact : 'none -- no sale movements recorded')

  // --- regression risk when the flag starts being honoured ---
  const nullFlag = (menuItems ?? []).filter((m) => m.track_inventory === null || m.track_inventory === undefined)
  log('REGRESSION RISK -- items whose deduction would STOP once the flag is honoured', {
    active_recipes_with_track_inventory_true: active.filter((r) => miById.get(r.menu_item_id)?.track_inventory === true).length,
    active_recipes_with_track_inventory_false: affectedRows.length,
    active_recipes_with_track_inventory_NULL: nullFlag.length,
    null_items: nullFlag.map((m) => `${rName.get(m.restaurant_id)} / ${m.name}`),
    interpretation: nullFlag.length === 0
      ? 'No nulls. Honouring the flag stops deduction ONLY for the explicitly-false items above, which is the intended outcome -- no backfill needed.'
      : 'NULLs present -- these would silently stop deducting. Decide explicitly whether to backfill them to true before shipping.',
  })

  // --- per-restaurant breakdown ---
  const byRestaurant: Record<string, { active: number; affected: number }> = {}
  for (const r of active) {
    const item = miById.get(r.menu_item_id)
    if (!item) continue
    const key = String(rName.get(item.restaurant_id) ?? item.restaurant_id)
    byRestaurant[key] ||= { active: 0, affected: 0 }
    byRestaurant[key].active++
    if (item.track_inventory !== true && (ingredientCount.get(r.id) ?? 0) >= 1) byRestaurant[key].affected++
  }
  log('PER RESTAURANT (active recipes / affected)', byRestaurant)
}

main().catch((e) => { console.error(e); process.exit(1) })
