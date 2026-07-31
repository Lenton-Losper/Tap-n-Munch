/**
 * READ-ONLY: which menu items would become UNSELLABLE the moment the out-of-stock block goes
 * live, using real production balances.
 *
 * The rule: a TRACKED menu item with an active recipe is refused if ANY of its ingredients
 * has a ledger balance of zero or below. Untracked items are unaffected.
 *
 * This is the number that should decide go/no-go, because production stock is currently
 * known-unreliable: Receive Stock was broken for days (so stock-in was impossible), recipe
 * units are never converted (counts can be 1000x off), and several items already sit
 * negative. Blocking sales on a wrong count is worse than the oversell it prevents.
 *
 *   npx tsx --env-file=.env.local scripts/scope-out-of-stock-blast-radius-20260731.ts
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
    .from('recipes').select('id, restaurant_id, menu_item_id').eq('is_active', true)
  const { data: recipeItems } = await admin
    .from('recipe_items').select('recipe_id, stock_item_id, quantity')
  const { data: menuItems } = await admin
    .from('menu_items').select('id, name, restaurant_id, track_inventory, status')
    .in('id', [...new Set((recipes ?? []).map((r) => r.menu_item_id))])
  const miById = new Map((menuItems ?? []).map((m) => [m.id, m]))

  const stockIds = [...new Set((recipeItems ?? []).map((ri) => ri.stock_item_id))]
  const { data: stockRows } = await admin.from('stock_items').select('id, name').in('id', stockIds)
  const sName = new Map((stockRows ?? []).map((s) => [s.id, s.name]))

  const { data: movements } = await admin
    .from('stock_movements').select('stock_item_id, quantity_delta').in('stock_item_id', stockIds)
  const balance = new Map<string, number>()
  for (const id of stockIds) balance.set(id, 0)
  for (const m of movements ?? []) {
    balance.set(m.stock_item_id, (balance.get(m.stock_item_id) ?? 0) + Number(m.quantity_delta))
  }

  const itemsByRecipe = new Map<string, string[]>()
  for (const ri of recipeItems ?? []) {
    const list = itemsByRecipe.get(ri.recipe_id) ?? []
    list.push(ri.stock_item_id)
    itemsByRecipe.set(ri.recipe_id, list)
  }

  const blocked: Array<Record<string, unknown>> = []
  const fine: Array<Record<string, unknown>> = []

  for (const r of recipes ?? []) {
    const mi = miById.get(r.menu_item_id)
    if (!mi) continue
    if (mi.track_inventory !== true) continue // untracked -> never blocked

    const depleted = (itemsByRecipe.get(r.id) ?? [])
      .map((sid) => ({ name: sName.get(sid) ?? sid, balance: balance.get(sid) ?? 0 }))
      .filter((x) => x.balance <= 0)

    const row = {
      restaurant: rName.get(mi.restaurant_id) ?? mi.restaurant_id,
      menu_item: mi.name,
      menu_status: mi.status,
      currently_sellable: mi.status !== 'hidden',
      depleted_ingredients: depleted,
    }
    if (depleted.length) blocked.push(row)
    else fine.push(row)
  }

  const liveBlocked = blocked.filter((b) => b.currently_sellable)

  log('WOULD BECOME UNSELLABLE (tracked, active recipe, an ingredient at <= 0)', blocked)
  log('SUMMARY', {
    tracked_items_with_active_recipes: blocked.length + fine.length,
    would_be_blocked: blocked.length,
    would_be_blocked_AND_currently_on_sale: liveBlocked.length,
    unaffected: fine.length,
  })

  const byRestaurant: Record<string, { blocked: number; live_blocked: number; ok: number }> = {}
  for (const b of [...blocked, ...fine]) {
    const k = String(b.restaurant)
    byRestaurant[k] ||= { blocked: 0, live_blocked: 0, ok: 0 }
    if ((b.depleted_ingredients as unknown[]).length) {
      byRestaurant[k].blocked++
      if (b.currently_sellable) byRestaurant[k].live_blocked++
    } else byRestaurant[k].ok++
  }
  log('PER RESTAURANT', byRestaurant)

  log('READ THIS BEFORE DEPLOYING', liveBlocked.length === 0
    ? 'No item currently on sale would be blocked. Safe to deploy on this evidence.'
    : `${liveBlocked.length} item(s) CURRENTLY ON SALE would immediately become unsellable. `
      + 'Given Receive Stock was broken for days and recipe units are never converted, verify '
      + 'these counts are real before deploying -- a wrong count would stop legitimate trade.')
}

main().catch((e) => { console.error(e); process.exit(1) })
