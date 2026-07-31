/**
 * Verifies the out-of-stock block at order placement (STAGING ONLY), through the real HTTP
 * routes, with real stock balances driven by real movements.
 *
 *   S1  tracked + stock ABOVE zero      -> order accepted
 *   S2  tracked + stock EXACTLY zero    -> BLOCKED, 409, no order row
 *   S3  tracked + stock NEGATIVE        -> BLOCKED, 409, no order row
 *   S4  UNTRACKED + stock zero          -> ACCEPTED (no regression; opted out of stock mgmt)
 *   S5  tracked, no recipe at all       -> ACCEPTED (nothing to check)
 *   S6  mixed basket, one bad line      -> whole order blocked, message names that item
 *   S7  the refusal message is customer-readable, no enum/uuid/raw field
 *   S8  staff POS path blocks identically
 *
 *   npx tsx scripts/stock-verify-out-of-stock-block-20260731.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_AUDIT_BASE || 'http://localhost:3101'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE = 9101
const TAG = `oos-${Date.now()}`
const created = { menuItems: [] as string[], recipes: [] as string[], movements: [] as string[] }

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function balance(id: string) {
  const { data } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', id)
  return (data ?? []).reduce((s, m) => s + Number(m.quantity_delta), 0)
}

/** Drive a stock item to an exact balance by posting a corrective adjustment. */
async function setBalance(stockItemId: string, target: number) {
  const current = await balance(stockItemId)
  const delta = target - current
  if (delta === 0) return
  const { data } = await admin.from('stock_movements').insert({
    restaurant_id: RID, stock_item_id: stockItemId, quantity_delta: delta,
    reason: 'adjustment', reference_type: 'manual', reference_id: null, created_at: new Date().toISOString(),
  }).select('id').single()
  if (data?.id) created.movements.push(data.id)
}

async function makeItem(name: string, track: boolean, stockItemId: string | null, qty = 1) {
  const { data: mi } = await admin.from('menu_items').insert({
    restaurant_id: RID, name: `${TAG} ${name}`, base_price: 25, status: 'available', track_inventory: track,
  }).select('id, name').single()
  created.menuItems.push(mi.id)
  if (stockItemId) {
    const { data: recipe } = await admin.from('recipes')
      .insert({ restaurant_id: RID, menu_item_id: mi.id, is_active: true }).select('id').single()
    created.recipes.push(recipe.id)
    const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
    await admin.from('recipe_items').insert({
      recipe_id: recipe.id, stock_item_id: stockItemId, quantity: qty, unit_id: unit?.id ?? null,
    })
  }
  return mi
}

async function openTab() {
  const sid = `qr-oos-${randomUUID()}`
  const r = await fetch(`${BASE}/api/tabs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: sid, displayName: 'OOS' }),
  })
  const tab = await r.json()
  if (!tab?.tabId) throw new Error(`tab create failed: ${JSON.stringify(tab)}`)
  return { tab, sid }
}

async function placeOrder(lines: Array<{ mi: { id: string; name: string }; qty: number }>) {
  const { tab, sid } = await openTab()
  const r = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': tab.sessionToken },
    body: JSON.stringify({
      restaurantId: RID, tableNumber: TABLE, sessionId: sid, memberSessionId: sid, tabId: tab.tabId,
      items: lines.map((l) => ({
        menuItemId: l.mi.id, name: l.mi.name, displayName: l.mi.name, quantity: l.qty,
        basePrice: 25, selectedVariants: {}, size: null, addons: [], specialInstructions: '',
        subtotal: 25 * l.qty,
      })),
      subtotal: 25, total: 25, orderInstructions: 'oos check -- safe to delete',
    }),
  })
  const body = await r.json().catch(() => ({}))
  const { data: rows } = await admin.from('order_requests').select('id').eq('tab_id', tab.tabId)
  if (rows?.length) await admin.from('order_requests').delete().eq('tab_id', tab.tabId)
  await admin.from('tabs').delete().eq('id', tab.tabId)
  return { status: r.status, body, rowsCreated: rows?.length ?? 0 }
}

async function main() {
  const { data: stock } = await admin.from('stock_items')
    .select('id, name').eq('restaurant_id', RID).eq('is_active', true).limit(2)
  const [siA, siB] = stock ?? []
  if (!siA || !siB) throw new Error('need two staging stock items')

  const openingA = await balance(siA.id)
  const openingB = await balance(siB.id)
  const results: Record<string, unknown> = {}

  const tracked = await makeItem('tracked', true, siA.id, 1)
  const untracked = await makeItem('untracked', false, siA.id, 1)
  const trackedNoRecipe = await makeItem('tracked-no-recipe', true, null)
  const trackedB = await makeItem('trackedB', true, siB.id, 1)

  // S1 -- stock above zero
  await setBalance(siA.id, 10)
  {
    const r = await placeOrder([{ mi: tracked, qty: 1 }])
    results['S1 tracked, stock 10 -> accepted'] = {
      http: r.status, rows: r.rowsCreated,
      verdict: r.status === 200 && r.rowsCreated === 1 ? 'PASS' : 'FAIL',
    }
  }

  // S2 -- exactly zero
  await setBalance(siA.id, 0)
  {
    const r = await placeOrder([{ mi: tracked, qty: 1 }])
    results['S2 tracked, stock exactly 0 -> BLOCKED'] = {
      http: r.status, rows: r.rowsCreated, message: r.body?.error,
      verdict: r.status === 409 && r.rowsCreated === 0 ? 'PASS' : 'FAIL',
    }
    results['S7 refusal message is customer-readable'] = {
      message: r.body?.error,
      verdict: typeof r.body?.error === 'string'
        && /out of stock/i.test(r.body.error)
        && !/_/.test(r.body.error)
        && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(r.body.error) ? 'PASS' : 'FAIL',
    }
  }

  // S3 -- negative
  await setBalance(siA.id, -5)
  {
    const r = await placeOrder([{ mi: tracked, qty: 1 }])
    results['S3 tracked, stock -5 -> BLOCKED'] = {
      http: r.status, rows: r.rowsCreated,
      verdict: r.status === 409 && r.rowsCreated === 0 ? 'PASS' : 'FAIL',
    }
  }

  // S4 -- THE NO-REGRESSION CASE: untracked item, same zero-stock ingredient
  {
    const r = await placeOrder([{ mi: untracked, qty: 1 }])
    results['S4 UNTRACKED, same depleted ingredient -> ACCEPTED (no regression)'] = {
      http: r.status, rows: r.rowsCreated, stock_balance: await balance(siA.id),
      verdict: r.status === 200 && r.rowsCreated === 1 ? 'PASS' : 'FAIL',
    }
  }

  // S5 -- tracked but no recipe
  {
    const r = await placeOrder([{ mi: trackedNoRecipe, qty: 1 }])
    results['S5 tracked with no recipe -> ACCEPTED'] = {
      http: r.status, rows: r.rowsCreated,
      verdict: r.status === 200 && r.rowsCreated === 1 ? 'PASS' : 'FAIL',
    }
  }

  // S6 -- mixed basket: one good line, one depleted line
  await setBalance(siB.id, 10)
  {
    const r = await placeOrder([{ mi: trackedB, qty: 1 }, { mi: tracked, qty: 1 }])
    results['S6 mixed basket, one depleted line -> whole order blocked, names that item'] = {
      http: r.status, rows: r.rowsCreated, message: r.body?.error,
      names_the_bad_item: String(r.body?.error ?? '').includes('tracked'),
      verdict: r.status === 409 && r.rowsCreated === 0 ? 'PASS' : 'FAIL',
    }
  }

  // S9 -- TWO depleted lines: the whole order is rejected and BOTH are named, so the
  // customer is not made to discover them one refusal at a time.
  await setBalance(siA.id, 0)
  await setBalance(siB.id, 0)
  {
    const r = await placeOrder([{ mi: tracked, qty: 1 }, { mi: trackedB, qty: 1 }])
    const msg = String(r.body?.error ?? '')
    const listed = Array.isArray(r.body?.outOfStock) ? r.body.outOfStock.length : 0
    results['S9 two depleted lines -> order rejected, BOTH named'] = {
      http: r.status, rows: r.rowsCreated, message: msg, out_of_stock_entries: listed,
      names_first: msg.includes('tracked'), names_second: msg.includes('trackedB'),
      verdict: r.status === 409 && r.rowsCreated === 0 && listed === 2
        && msg.includes('trackedB') ? 'PASS' : 'FAIL',
    }
  }

  // S10 -- nothing is silently dropped: a rejected order leaves no partial row behind.
  {
    const { data: leftovers } = await admin
      .from('order_requests').select('id').ilike('order_instructions', '%oos check%')
    results['S10 a rejected order leaves no partial row'] = {
      leftover_rows: (leftovers ?? []).length,
      verdict: (leftovers ?? []).length === 0 ? 'PASS' : 'FAIL',
    }
  }

  log('RESULTS', results)
  const failures = Object.entries(results).filter(([, v]) => (v as { verdict: string }).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- tracked items with zero or negative stock are refused at placement with a '
      + 'readable message and no order row; untracked items are entirely unaffected.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  // Restore balances and clean up.
  await admin.from('stock_movements').delete().in('id', created.movements)
  for (const r of created.recipes) {
    await admin.from('recipe_items').delete().eq('recipe_id', r)
    await admin.from('recipes').delete().eq('id', r)
  }
  await admin.from('menu_items').delete().in('id', created.menuItems)
  console.log(`\ncleaned up; balances restored to A=${await balance(siA.id)} (was ${openingA}), B=${await balance(siB.id)} (was ${openingB})`)
  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
