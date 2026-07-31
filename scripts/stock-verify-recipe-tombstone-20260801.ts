/**
 * Verifies recipe SOFT delete (tombstone) end to end (STAGING ONLY), with real orders through
 * the real deduction trigger.
 *
 * The point of a tombstone is that truth is preserved and state is explicit. The danger is
 * that it becomes a new ambiguous half-state -- a row that exists, is invisible on one screen,
 * and still behaves on another. That is the exact bug fixed earlier tonight, so every read
 * path is checked, not just the happy one.
 *
 *   T1  removal sets deleted_at and keeps the row AND its ingredients (truth preserved)
 *   T2  a sale after removal deducts NOTHING (the tombstone is honoured by deduction)
 *   T3  the earlier sale's movement is untouched (history not rewritten)
 *   T4  gone from every tracking surface (setup overview, editor)
 *   T5  untick vs remove remain distinguishable
 *   T6  a tombstoned item is NOT blocked by the out-of-stock check (no live link to check)
 *   T7  re-linking REVIVES the tombstoned row -- required, because recipes has
 *       UNIQUE (restaurant_id, menu_item_id) so a second insert would fail
 *   T8  after revival deduction works again
 *
 *   npx tsx scripts/stock-verify-recipe-tombstone-20260801.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { getInventorySetupOverview, getRecipeEditorData } from '../lib/recipes/queries'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAG = `tomb-${Date.now()}`
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

/** Mirrors removeRecipeLinkAction: tombstone the recipe, keep its rows, turn tracking off. */
async function removeLink(menuItemId: string) {
  const { data: recipe } = await admin.from('recipes')
    .select('id').eq('restaurant_id', RID).eq('menu_item_id', menuItemId).maybeSingle()
  if (recipe?.id) {
    await admin.from('recipes')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', recipe.id).eq('restaurant_id', RID)
  }
  await admin.from('menu_items').update({ track_inventory: false })
    .eq('restaurant_id', RID).eq('id', menuItemId)
  return Boolean(recipe?.id)
}

/** Mirrors saveRecipeAction's reuse-and-revive path. */
async function relink(menuItemId: string, stockItemId: string, qty: number) {
  const { data: recipe } = await admin.from('recipes')
    .select('id').eq('restaurant_id', RID).eq('menu_item_id', menuItemId).maybeSingle()
  await admin.from('recipes')
    .update({ is_active: true, deleted_at: null }).eq('id', recipe.id)
  await admin.from('recipe_items').delete().eq('recipe_id', recipe.id)
  const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
  await admin.from('recipe_items').insert({
    recipe_id: recipe.id, stock_item_id: stockItemId, quantity: qty, unit_id: unit?.id ?? null,
  })
  await admin.from('menu_items').update({ track_inventory: true }).eq('id', menuItemId)
}

async function state(menuItemId: string) {
  const { data: recipe } = await admin.from('recipes')
    .select('id, is_active, deleted_at').eq('restaurant_id', RID).eq('menu_item_id', menuItemId).maybeSingle()
  const { data: items } = recipe?.id
    ? await admin.from('recipe_items').select('id').eq('recipe_id', recipe.id)
    : { data: [] }
  const { data: mi } = await admin.from('menu_items').select('track_inventory').eq('id', menuItemId).maybeSingle()
  return {
    row_retained: Boolean(recipe?.id),
    tombstoned: Boolean(recipe?.deleted_at),
    is_active: recipe?.is_active ?? null,
    ingredients_retained: (items ?? []).length,
    track_inventory: mi?.track_inventory ?? null,
  }
}

async function main() {
  const { data: si } = await admin.from('stock_items')
    .select('id, name').eq('restaurant_id', RID).eq('is_active', true).limit(1).maybeSingle()
  if (!si) throw new Error('no staging stock item')
  const results: Record<string, unknown> = {}

  // T1..T4
  {
    const { mi } = await makeLinked('removed', si.id, 4)
    const b1 = await balance(si.id)
    await sell(mi)
    const a1 = await balance(si.id)

    await removeLink(mi.id)
    const st = await state(mi.id)

    const b2 = await balance(si.id)
    await sell(mi)
    const a2 = await balance(si.id)

    const overview = await getInventorySetupOverview(admin, RID)
    const editor = await getRecipeEditorData(admin, RID, mi.id)

    results['T1 tombstone keeps the row AND its ingredients'] = {
      ...st,
      verdict: st.row_retained && st.tombstoned && st.ingredients_retained === 1
        && st.track_inventory === false ? 'PASS' : 'FAIL',
    }
    results['T2 a sale after removal deducts nothing'] = {
      delta: a2 - b2, expected: 0, verdict: a2 - b2 === 0 ? 'PASS' : 'FAIL',
    }
    results['T3 the earlier sale is untouched'] = {
      delta: a1 - b1, expected: -4, verdict: a1 - b1 === -4 ? 'PASS' : 'FAIL',
    }
    results['T4 gone from every tracking surface'] = {
      in_ready: overview.readyMenuItemIds.includes(mi.id),
      in_missing: overview.missingItems.some((m) => String(m.menuItemId) === mi.id),
      in_linked_but_untracked: overview.linkedButUntrackedIds.includes(mi.id),
      editor_ingredients: editor?.ingredients.length ?? null,
      verdict: !overview.readyMenuItemIds.includes(mi.id)
        && !overview.missingItems.some((m) => String(m.menuItemId) === mi.id)
        && !overview.linkedButUntrackedIds.includes(mi.id)
        && (editor?.ingredients.length ?? 0) === 0 ? 'PASS' : 'FAIL',
    }
  }

  // T5 -- untick vs remove
  {
    const { mi: a } = await makeLinked('unticked', si.id, 4)
    await admin.from('menu_items').update({ track_inventory: false }).eq('id', a.id)
    const untick = await state(a.id)

    const { mi: b } = await makeLinked('removed2', si.id, 4)
    await removeLink(b.id)
    const remove = await state(b.id)

    results['T5 untick leaves a LIVE recipe; remove tombstones it'] = {
      after_untick: untick, after_remove: remove,
      verdict: untick.tombstoned === false && untick.is_active === true
        && remove.tombstoned === true && remove.is_active === false ? 'PASS' : 'FAIL',
    }
  }

  // T6 -- a tombstoned item must not be blocked by the out-of-stock check
  {
    const { mi } = await makeLinked('oos', si.id, 4)
    await removeLink(mi.id)
    const { data, error } = await admin.rpc('check_stock_sufficiency_locked', {
      p_restaurant_id: RID, p_menu_item_ids: [mi.id],
    })
    results['T6 tombstoned item is not blocked by the stock check'] = {
      error: error?.message ?? null, rows_returned: (data ?? []).length,
      verdict: !error && (data ?? []).length === 0 ? 'PASS' : 'FAIL',
    }
  }

  // T7 + T8 -- revival
  {
    const { mi } = await makeLinked('revived', si.id, 4)
    await removeLink(mi.id)
    const afterRemove = await state(mi.id)

    await relink(mi.id, si.id, 2)
    const afterRelink = await state(mi.id)

    const b = await balance(si.id)
    await sell(mi)
    const a = await balance(si.id)

    results['T7 re-linking revives the tombstoned row'] = {
      after_remove: afterRemove, after_relink: afterRelink,
      verdict: afterRemove.tombstoned === true && afterRelink.tombstoned === false
        && afterRelink.is_active === true && afterRelink.track_inventory === true ? 'PASS' : 'FAIL',
    }
    results['T8 deduction works again after revival'] = {
      delta: a - b, expected: -2, verdict: a - b === -2 ? 'PASS' : 'FAIL',
    }
  }

  log('RESULTS', results)
  const failures = Object.entries(results).filter(([, v]) => (v as { verdict: string }).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- a removed recipe is tombstoned rather than erased: the row and ingredients are '
      + 'kept as a record, deduction stops, every tracking surface treats it as gone, history '
      + 'is untouched, it is not blocked by the stock check, and re-linking revives it.'
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
