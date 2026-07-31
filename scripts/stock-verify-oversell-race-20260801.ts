/**
 * Measures the simultaneous-last-item race with REAL concurrent HTTP requests (STAGING ONLY).
 *
 * Does not assume the lock fixes it. Sets a tracked item's stock to exactly 1, fires N
 * genuinely concurrent order placements, and counts how many were accepted.
 *
 *   R1  N concurrent orders, stock 1  -> how many got through?
 *   R2  N concurrent orders, stock 0  -> all must be refused (the lock must not create a hole)
 *   R3  the locked RPC and the fallback agree on the same data
 *
 *   npx tsx scripts/stock-verify-oversell-race-20260801.ts
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
const TAG = `race-${Date.now()}`
const CONCURRENCY = 8
const created = { menuItems: [] as string[], recipes: [] as string[], movements: [] as string[] }

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function balance(id: string) {
  const { data } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', id)
  return (data ?? []).reduce((s, m) => s + Number(m.quantity_delta), 0)
}

async function setBalance(stockItemId: string, target: number) {
  const delta = target - (await balance(stockItemId))
  if (delta === 0) return
  const { data } = await admin.from('stock_movements').insert({
    restaurant_id: RID, stock_item_id: stockItemId, quantity_delta: delta,
    reason: 'adjustment', reference_type: 'manual', created_at: new Date().toISOString(),
  }).select('id').single()
  if (data?.id) created.movements.push(data.id)
}

async function makeTracked(stockItemId: string) {
  const { data: mi } = await admin.from('menu_items').insert({
    restaurant_id: RID, name: `${TAG} last-unit`, base_price: 25, status: 'available', track_inventory: true,
  }).select('id, name').single()
  created.menuItems.push(mi.id)
  const { data: recipe } = await admin.from('recipes')
    .insert({ restaurant_id: RID, menu_item_id: mi.id, is_active: true }).select('id').single()
  created.recipes.push(recipe.id)
  const { data: unit } = await admin.from('measurement_units').select('id').limit(1).maybeSingle()
  await admin.from('recipe_items').insert({
    recipe_id: recipe.id, stock_item_id: stockItemId, quantity: 1, unit_id: unit?.id ?? null,
  })
  return mi
}

async function openTab() {
  const sid = `race-${randomUUID()}`
  const r = await fetch(`${BASE}/api/tabs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: sid, displayName: 'Race' }),
  })
  const tab = await r.json()
  if (!tab?.tabId) throw new Error(`tab create failed: ${JSON.stringify(tab)}`)
  return { tab, sid }
}

/** One fully-independent placement, prepared up front so the fetches fire together. */
async function prepare(mi: { id: string; name: string }) {
  const { tab, sid } = await openTab()
  return async () => {
    const r = await fetch(`${BASE}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': tab.sessionToken },
      body: JSON.stringify({
        restaurantId: RID, tableNumber: TABLE, sessionId: sid, memberSessionId: sid, tabId: tab.tabId,
        items: [{
          menuItemId: mi.id, name: mi.name, displayName: mi.name, quantity: 1,
          basePrice: 25, selectedVariants: {}, size: null, addons: [], specialInstructions: '', subtotal: 25,
        }],
        subtotal: 25, total: 25, orderInstructions: 'race check -- safe to delete',
      }),
    })
    return { status: r.status, tabId: tab.tabId }
  }
}

async function runConcurrent(mi: { id: string; name: string }, n: number) {
  const calls = await Promise.all(Array.from({ length: n }, () => prepare(mi)))
  const settled = await Promise.all(calls.map((c) => c()))
  const { data: rows } = await admin.from('order_requests')
    .select('id, tab_id').in('tab_id', settled.map((s) => s.tabId))
  // Clean up as we go.
  if (rows?.length) await admin.from('order_requests').delete().in('id', rows.map((r) => r.id))
  await admin.from('tabs').delete().in('id', settled.map((s) => s.tabId))
  return {
    accepted: settled.filter((s) => s.status === 200).length,
    refused: settled.filter((s) => s.status === 409).length,
    other: settled.filter((s) => s.status !== 200 && s.status !== 409).length,
    rowsCreated: rows?.length ?? 0,
  }
}

async function main() {
  const { data: si } = await admin.from('stock_items')
    .select('id, name').eq('restaurant_id', RID).eq('is_active', true).limit(1).maybeSingle()
  if (!si) throw new Error('no staging stock item')
  const opening = await balance(si.id)
  const results: Record<string, unknown> = {}

  const mi = await makeTracked(si.id)

  // R1 -- the actual race: exactly one unit, many simultaneous buyers.
  await setBalance(si.id, 1)
  {
    const r = await runConcurrent(mi, CONCURRENCY)
    results[`R1 ${CONCURRENCY} concurrent orders against stock of 1`] = {
      ...r,
      note: 'accepted > 1 means the race is real and the lock does not prevent it',
      race_prevented: r.accepted <= 1,
    }
  }

  // R2 -- the lock must not accidentally let anything through at zero.
  await setBalance(si.id, 0)
  {
    const r = await runConcurrent(mi, CONCURRENCY)
    results[`R2 ${CONCURRENCY} concurrent orders against stock of 0`] = {
      ...r,
      verdict: r.accepted === 0 && r.rowsCreated === 0 ? 'PASS' : 'FAIL',
    }
  }

  // R3 -- the locked RPC agrees with the data it is reading.
  await setBalance(si.id, 0)
  {
    const { data, error } = await admin.rpc('check_stock_sufficiency_locked', {
      p_restaurant_id: RID, p_menu_item_ids: [mi.id],
    })
    results['R3 locked RPC reports the depleted item'] = {
      error: error?.message ?? null,
      rows: (data ?? []).length,
      reported: (data ?? []).map((r: Record<string, unknown>) => ({
        item: r.menu_item_name, stock: r.stock_item_name, balance: r.balance,
      })),
      verdict: !error && (data ?? []).length === 1 ? 'PASS' : 'FAIL',
    }
  }

  log('RESULTS', results)

  const r1 = results[`R1 ${CONCURRENCY} concurrent orders against stock of 1`] as { accepted: number; race_prevented: boolean }
  log('WHAT THIS ACTUALLY SHOWS', r1.race_prevented
    ? `Row locking held: ${r1.accepted} of ${CONCURRENCY} concurrent orders were accepted against a stock of 1.`
    : `Row locking did NOT prevent the oversell: ${r1.accepted} of ${CONCURRENCY} concurrent orders `
      + 'were accepted against a stock of 1. The lock serialises the CHECK, but nothing decrements '
      + 'between callers, so each one still observes a positive balance. Closing this needs the '
      + 'order insert inside the same transaction as the check -- not a lock alone.')

  await admin.from('stock_movements').delete().in('id', created.movements)
  for (const r of created.recipes) {
    await admin.from('recipe_items').delete().eq('recipe_id', r)
    await admin.from('recipes').delete().eq('id', r)
  }
  await admin.from('menu_items').delete().in('id', created.menuItems)
  console.log(`\ncleaned up; balance restored to ${await balance(si.id)} (was ${opening})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
