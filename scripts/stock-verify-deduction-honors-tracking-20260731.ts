/**
 * Verifies deduct_recipe_stock now honours track_inventory (STAGING ONLY).
 *
 * Drives real orders through the real trigger (AFTER UPDATE OF status -> 'completed') and
 * asserts against actual stock_movements rows and before/after balances. Not unit tests.
 *
 *   D1  tracked + linked            -> deducts, correct quantity
 *   D2  UNTRACKED + linked          -> ZERO movements, balance unchanged   <- the fix
 *   D3  re-ticking tracking         -> deduction resumes
 *   D4  multi-ingredient recipe     -> every ingredient still deducted
 *   D5  quantity > 1                -> deduction scales with line quantity
 *   D6  idempotency preserved       -> re-completing posts nothing further
 *   D7  track_inventory NULL        -> impossible; the column is NOT NULL
 *
 *   npx tsx scripts/stock-verify-deduction-honors-tracking-20260731.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAG = `dedtrack-${Date.now()}`

const created = { menuItems: [] as string[], recipes: [] as string[], orders: [] as string[] }

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function balance(stockItemId: string) {
  const { data } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', stockItemId)
  return (data ?? []).reduce((s, m) => s + Number(m.quantity_delta), 0)
}

async function stockItems(n: number) {
  const { data } = await admin
    .from('stock_items').select('id, name').eq('restaurant_id', RID).eq('is_active', true).limit(n)
  if (!data || data.length < n) throw new Error(`need ${n} staging stock items, found ${data?.length ?? 0}`)
  return data
}

async function makeMenuItem(name: string, track: boolean) {
  const { data, error } = await admin.from('menu_items').insert({
    restaurant_id: RID, name: `${TAG} ${name}`, base_price: 20, status: 'available', track_inventory: track,
  }).select('id, name, track_inventory').single()
  if (error) throw new Error(`menu item insert failed: ${error.message}`)
  created.menuItems.push(data.id)
  return data
}

async function linkRecipe(menuItemId: string, ingredients: Array<{ id: string; qty: number }>) {
  const { data: recipe, error } = await admin.from('recipes')
    .insert({ restaurant_id: RID, menu_item_id: menuItemId, is_active: true }).select('id').single()
  if (error) throw new Error(`recipe insert failed: ${error.message}`)
  created.recipes.push(recipe.id)
  const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
  for (const ing of ingredients) {
    await admin.from('recipe_items').insert({
      recipe_id: recipe.id, stock_item_id: ing.id, quantity: ing.qty, unit_id: unit?.id ?? null,
    })
  }
  return recipe.id
}

/** Creates an order in a non-completed state, then flips it to completed so the trigger fires. */
async function sell(menuItem: { id: string; name: string }, qty: number) {
  const { data: order, error } = await admin.from('orders').insert({
    restaurant_id: RID, channel: 'pos', table_number: 0, status: 'pending',
    payment_status: 'pending', subtotal: 20 * qty, total: 20 * qty,
    items: [{ menuItemId: menuItem.id, name: menuItem.name, quantity: qty, basePrice: 20 }],
    placed_at: new Date().toISOString(),
  }).select('id').single()
  if (error) throw new Error(`order insert failed: ${error.message}`)
  created.orders.push(order.id)

  await admin.from('orders').update({ status: 'completed' }).eq('id', order.id)
  return order.id
}

async function movementsFor(orderId: string) {
  const { data } = await admin.from('stock_movements')
    .select('id, stock_item_id, quantity_delta, reason').eq('reference_id', orderId)
  return data ?? []
}

async function main() {
  const [siA, siB] = await stockItems(2)
  const results: Record<string, unknown> = {}

  // D1 -- tracked + linked
  {
    const mi = await makeMenuItem('tracked', true)
    await linkRecipe(mi.id, [{ id: siA.id, qty: 3 }])
    const before = await balance(siA.id)
    const orderId = await sell(mi, 1)
    const mv = await movementsFor(orderId)
    const after = await balance(siA.id)
    results['D1 tracked + linked deducts'] = {
      movements: mv.length, delta: after - before, expected_delta: -3,
      verdict: mv.length === 1 && after - before === -3 ? 'PASS' : 'FAIL',
    }
  }

  // D2 -- THE FIX: untracked + linked must deduct nothing
  {
    const mi = await makeMenuItem('untracked', false)
    await linkRecipe(mi.id, [{ id: siA.id, qty: 3 }])
    const before = await balance(siA.id)
    const orderId = await sell(mi, 1)
    const mv = await movementsFor(orderId)
    const after = await balance(siA.id)
    results['D2 UNTRACKED + linked deducts NOTHING'] = {
      movements: mv.length, delta: after - before, expected_delta: 0,
      verdict: mv.length === 0 && after - before === 0 ? 'PASS' : 'FAIL',
    }
  }

  // D3 -- re-ticking tracking resumes deduction
  {
    const mi = await makeMenuItem('resumed', false)
    await linkRecipe(mi.id, [{ id: siA.id, qty: 2 }])
    const beforeOff = await balance(siA.id)
    await sell(mi, 1)
    const afterOff = await balance(siA.id)

    await admin.from('menu_items').update({ track_inventory: true }).eq('id', mi.id)
    const orderId = await sell(mi, 1)
    const mv = await movementsFor(orderId)
    const afterOn = await balance(siA.id)

    results['D3 re-ticking resumes deduction'] = {
      while_off_delta: afterOff - beforeOff, expected_off: 0,
      while_on_movements: mv.length, while_on_delta: afterOn - afterOff, expected_on: -2,
      verdict: afterOff - beforeOff === 0 && mv.length === 1 && afterOn - afterOff === -2 ? 'PASS' : 'FAIL',
    }
  }

  // D4 -- multi-ingredient
  {
    const mi = await makeMenuItem('multi', true)
    await linkRecipe(mi.id, [{ id: siA.id, qty: 2 }, { id: siB.id, qty: 5 }])
    const bA = await balance(siA.id); const bB = await balance(siB.id)
    const orderId = await sell(mi, 1)
    const mv = await movementsFor(orderId)
    const aA = await balance(siA.id); const aB = await balance(siB.id)
    results['D4 multi-ingredient deducts every ingredient'] = {
      movements: mv.length, deltaA: aA - bA, deltaB: aB - bB,
      verdict: mv.length === 2 && aA - bA === -2 && aB - bB === -5 ? 'PASS' : 'FAIL',
    }
  }

  // D5 -- scales with line quantity
  {
    const mi = await makeMenuItem('qty4', true)
    await linkRecipe(mi.id, [{ id: siB.id, qty: 3 }])
    const before = await balance(siB.id)
    const orderId = await sell(mi, 4)
    const after = await balance(siB.id)
    results['D5 scales with line quantity'] = {
      delta: after - before, expected_delta: -12,
      verdict: after - before === -12 ? 'PASS' : 'FAIL',
    }
  }

  // D6 -- idempotency unchanged
  {
    const mi = await makeMenuItem('idem', true)
    await linkRecipe(mi.id, [{ id: siA.id, qty: 1 }])
    const orderId = await sell(mi, 1)
    const first = (await movementsFor(orderId)).length
    const mid = await balance(siA.id)
    // Flip away and back so the trigger fires a second time for the same order.
    await admin.from('orders').update({ status: 'pending' }).eq('id', orderId)
    await admin.from('orders').update({ status: 'completed' }).eq('id', orderId)
    const second = (await movementsFor(orderId)).length
    const end = await balance(siA.id)
    results['D6 idempotency preserved'] = {
      movements_after_first: first, movements_after_second: second, balance_moved_again: end - mid,
      verdict: first === 1 && second === 1 && end - mid === 0 ? 'PASS' : 'FAIL',
    }
  }

  // D7 -- a NULL flag cannot exist, so it cannot silently deduct.
  //
  // Originally this tried to insert track_inventory = NULL and assert it deducted nothing.
  // The insert is rejected: the column is NOT NULL. That is stronger evidence than counting
  // NULLs in the data -- the regression risk of an item silently ceasing to deduct because
  // of an absent flag is structurally impossible, not merely absent today. The migration
  // still compares with IS TRUE rather than = true, which costs nothing and stays correct if
  // the constraint is ever relaxed.
  {
    const { error } = await admin.from('menu_items').insert({
      restaurant_id: RID, name: `${TAG} nullflag`, base_price: 20, status: 'available',
      track_inventory: null,
    }).select('id').single()
    const rejected = Boolean(error) && /not-null|null value/i.test(String(error?.message))
    results['D7 NULL track_inventory is impossible (NOT NULL constraint)'] = {
      insert_rejected: rejected,
      error: error?.message ?? null,
      verdict: rejected ? 'PASS' : 'FAIL',
    }
  }

  log('RESULTS', results)
  const failures = Object.entries(results).filter(([, v]) => (v as { verdict: string }).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- deduction now requires BOTH an active recipe and track_inventory. Tracked items '
      + 'deduct exactly as before (quantities, multi-ingredient, scaling, idempotency all '
      + 'unchanged); untracked items deduct nothing at all, and a NULL flag is impossible.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  // Cleanup.
  await admin.from('stock_movements').delete().in('reference_id', created.orders)
  await admin.from('orders').delete().in('id', created.orders)
  for (const r of created.recipes) {
    await admin.from('recipe_items').delete().eq('recipe_id', r)
    await admin.from('recipes').delete().eq('id', r)
  }
  await admin.from('menu_items').delete().in('id', created.menuItems)
  console.log(`\ncleaned up ${created.orders.length} orders, ${created.recipes.length} recipes, ${created.menuItems.length} menu items`)

  if (failures.length) process.exit(1)
}

main().catch(async (e) => { console.error(e); process.exit(1) })
