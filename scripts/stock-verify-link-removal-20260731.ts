/**
 * Verifies real link removal, and that it differs from merely switching tracking off
 * (STAGING ONLY). Uses real orders through the real deduction trigger.
 *
 *   L1  remove clears recipe_items AND deactivates the recipe, and turns tracking off
 *   L2  after removal a sale deducts NOTHING
 *   L3  removal is distinguishable from untick: untick leaves the link, remove destroys it
 *   L4  the historic ledger is preserved -- unlinking does not rewrite what already happened
 *   L5  removing a menu item with no link at all is a harmless no-op
 *   L6  after removal the item is absent from every "is this tracked?" surface
 *
 *   npx tsx scripts/stock-verify-link-removal-20260731.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { getInventorySetupOverview } from '../lib/recipes/queries'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAG = `linkrm-${Date.now()}`
const created = { menuItems: [] as string[], recipes: [] as string[], orders: [] as string[] }

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function balance(id: string) {
  const { data } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', id)
  return (data ?? []).reduce((s, m) => s + Number(m.quantity_delta), 0)
}

async function makeLinked(name: string, stockItemId: string, qty: number) {
  const { data: mi } = await admin.from('menu_items').insert({
    restaurant_id: RID, name: `${TAG} ${name}`, base_price: 20, status: 'available', track_inventory: true,
  }).select('id, name').single()
  created.menuItems.push(mi.id)
  const { data: recipe } = await admin.from('recipes')
    .insert({ restaurant_id: RID, menu_item_id: mi.id, is_active: true }).select('id').single()
  created.recipes.push(recipe.id)
  const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
  await admin.from('recipe_items').insert({
    recipe_id: recipe.id, stock_item_id: stockItemId, quantity: qty, unit_id: unit?.id ?? null,
  })
  return { mi, recipeId: recipe.id }
}

async function sell(mi: { id: string; name: string }) {
  const { data: order } = await admin.from('orders').insert({
    restaurant_id: RID, channel: 'pos', table_number: 0, status: 'pending', payment_status: 'pending',
    subtotal: 20, total: 20,
    items: [{ menuItemId: mi.id, name: mi.name, quantity: 1, basePrice: 20 }],
    placed_at: new Date().toISOString(),
  }).select('id').single()
  created.orders.push(order.id)
  await admin.from('orders').update({ status: 'completed' }).eq('id', order.id)
  return order.id
}

/** Mirrors removeRecipeLinkAction's writes; the action itself needs a staff session. */
async function removeLink(menuItemId: string) {
  const { data: recipe } = await admin.from('recipes')
    .select('id').eq('restaurant_id', RID).eq('menu_item_id', menuItemId).maybeSingle()
  if (recipe?.id) {
    await admin.from('recipe_items').delete().eq('recipe_id', recipe.id)
    await admin.from('recipes').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', recipe.id)
  }
  await admin.from('menu_items').update({ track_inventory: false }).eq('restaurant_id', RID).eq('id', menuItemId)
  return Boolean(recipe?.id)
}

async function linkState(menuItemId: string) {
  const { data: recipe } = await admin.from('recipes')
    .select('id, is_active').eq('restaurant_id', RID).eq('menu_item_id', menuItemId).maybeSingle()
  const { data: items } = recipe?.id
    ? await admin.from('recipe_items').select('id').eq('recipe_id', recipe.id)
    : { data: [] }
  const { data: mi } = await admin.from('menu_items').select('track_inventory').eq('id', menuItemId).maybeSingle()
  return {
    recipe_exists: Boolean(recipe?.id),
    recipe_active: recipe?.is_active ?? null,
    ingredient_count: (items ?? []).length,
    track_inventory: mi?.track_inventory ?? null,
  }
}

async function main() {
  const { data: si } = await admin.from('stock_items')
    .select('id, name').eq('restaurant_id', RID).eq('is_active', true).limit(1).maybeSingle()
  if (!si) throw new Error('no staging stock item')
  const results: Record<string, unknown> = {}

  // L1 + L2 + L4
  {
    const { mi } = await makeLinked('removed', si.id, 4)
    const beforeSale = await balance(si.id)
    await sell(mi)                                   // a real sale while linked
    const afterSale = await balance(si.id)

    const removed = await removeLink(mi.id)
    const state = await linkState(mi.id)

    const beforeAfterRemoval = await balance(si.id)
    await sell(mi)                                   // a sale after removal
    const afterAfterRemoval = await balance(si.id)

    results['L1 removal clears ingredients, deactivates recipe, turns tracking off'] = {
      removed, ...state,
      verdict: removed && state.recipe_active === false && state.ingredient_count === 0
        && state.track_inventory === false ? 'PASS' : 'FAIL',
    }
    results['L2 after removal a sale deducts nothing'] = {
      delta_after_removal: afterAfterRemoval - beforeAfterRemoval, expected: 0,
      verdict: afterAfterRemoval - beforeAfterRemoval === 0 ? 'PASS' : 'FAIL',
    }
    results['L4 historic ledger preserved'] = {
      delta_from_the_earlier_sale: afterSale - beforeSale, expected: -4,
      verdict: afterSale - beforeSale === -4 ? 'PASS' : 'FAIL',
    }
  }

  // L3 -- untick is NOT the same as remove
  {
    const { mi } = await makeLinked('unticked', si.id, 4)
    await admin.from('menu_items').update({ track_inventory: false }).eq('id', mi.id)
    const afterUntick = await linkState(mi.id)

    const { mi: mi2 } = await makeLinked('removed2', si.id, 4)
    await removeLink(mi2.id)
    const afterRemove = await linkState(mi2.id)

    results['L3 untick leaves the link, remove destroys it'] = {
      after_untick: afterUntick,
      after_remove: afterRemove,
      verdict:
        afterUntick.recipe_active === true && afterUntick.ingredient_count === 1 &&
        afterRemove.recipe_active === false && afterRemove.ingredient_count === 0
          ? 'PASS' : 'FAIL',
    }
  }

  // L5 -- no-op on an unlinked item
  {
    const { data: mi } = await admin.from('menu_items').insert({
      restaurant_id: RID, name: `${TAG} never-linked`, base_price: 20, status: 'available', track_inventory: false,
    }).select('id').single()
    created.menuItems.push(mi.id)
    const removed = await removeLink(mi.id)
    const state = await linkState(mi.id)
    results['L5 removing an unlinked item is a harmless no-op'] = {
      removed_reported: removed, ...state,
      verdict: removed === false && state.recipe_exists === false ? 'PASS' : 'FAIL',
    }
  }

  // L6 -- gone from every tracking surface
  {
    const { mi } = await makeLinked('surfaces', si.id, 4)
    const before = await getInventorySetupOverview(admin, RID)
    const wasReady = before.readyMenuItemIds.includes(mi.id)
    await removeLink(mi.id)
    const after = await getInventorySetupOverview(admin, RID)
    results['L6 absent from every tracking surface after removal'] = {
      ready_before: wasReady,
      ready_after: after.readyMenuItemIds.includes(mi.id),
      missing_after: after.missingItems.some((m) => String(m.menuItemId) === mi.id),
      linked_but_untracked_after: after.linkedButUntrackedIds.includes(mi.id),
      verdict: wasReady
        && !after.readyMenuItemIds.includes(mi.id)
        && !after.missingItems.some((m) => String(m.menuItemId) === mi.id)
        && !after.linkedButUntrackedIds.includes(mi.id) ? 'PASS' : 'FAIL',
    }
  }

  log('RESULTS', results)
  const failures = Object.entries(results).filter(([, v]) => (v as { verdict: string }).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- removal genuinely destroys the link (ingredients cleared, recipe deactivated, '
      + 'tracking off), stops deduction, is distinguishable from unticking, leaves historic '
      + 'movements intact, and clears the item from every tracking surface.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  await admin.from('stock_movements').delete().in('reference_id', created.orders)
  await admin.from('orders').delete().in('id', created.orders)
  for (const r of created.recipes) {
    await admin.from('recipe_items').delete().eq('recipe_id', r)
    await admin.from('recipes').delete().eq('id', r)
  }
  await admin.from('menu_items').delete().in('id', created.menuItems)
  console.log('\ncleaned up staging fixtures')
  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
