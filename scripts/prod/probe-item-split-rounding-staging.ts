/**
 * PROVE THE ARITHMETIC CANNOT ROUND ITS WAY TO PAID.
 *
 * The owner's own requirement, verbatim: "Financial records are append-only, a part-paid order
 * is never rewritten, and an order is fully paid only when every line is - prove the arithmetic
 * cannot round its way to paid." This does not assert that in a mock -- it fires real inserts,
 * real splits, and real settlement RPC calls against REAL staging Postgres (mdqjpxwczrhkxkbqatqa),
 * the same two-guard shape every other real-staging probe in this session uses
 * (scripts/prod/probe-amend-cook-race-staging.ts is the template this file follows), and reads
 * every number back from the database rather than trusting what this script thinks it wrote.
 *
 * FOUR CLAIMS, EACH PROVEN SEPARATELY:
 *
 *   1. EXACT RECONSTRUCTION. An order line's total, split N adversarial ways (amounts chosen
 *      specifically because they do NOT divide evenly), sums back to EXACTLY the line's own
 *      total in cents when read back from order_line_allocations after insert -- no leftover
 *      cent dropped, none invented.
 *
 *   2. NO PREMATURE "PAID". order_is_fully_paid_by_allocations() is read after every one of N
 *      settlements except the last, and must be false every single time -- a partial sum can
 *      never be misread as fully paid. It is read once more after the Nth (final) settlement and
 *      must be true.
 *
 *   3. NO DOUBLE-COUNTING UNDER CONCURRENCY. The same allocation is settled by two concurrent
 *      RPC calls at once; exactly one must succeed and the ledger must show exactly one
 *      settlement row for it, not zero and not two -- so a race cannot inflate the paid total
 *      past what was actually collected.
 *
 *   4. THE ORDER FLIPS TO PAID EXACTLY ONCE. Once fully paid, orders.payment_status is read back
 *      as 'paid', and the order's own total/items are asserted UNCHANGED from what this script
 *      wrote at creation -- the completion write never touches those columns.
 *
 * Usage: npx tsx scripts/prod/probe-item-split-rounding-staging.ts
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { splitCentsByWeight, sumCents, isFullyPaidCents } from '../../lib/billing/split-cents'

config({ path: resolve(__dirname, '../../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
if (!URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL is not staging (${STAGING_REF}). Got: ${URL || '(empty)'}`)
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // 'staging test'

let failures = 0
function assertTrue(condition: boolean, message: string) {
  if (condition) {
    console.log(`  OK: ${message}`)
  } else {
    failures += 1
    console.error(`  FAIL: ${message}`)
  }
}

async function pickFreeTable(): Promise<{ id: string; table_number: number }> {
  const [{ data: tables, error: tablesError }, { data: openTabs, error: openTabsError }] = await Promise.all([
    db.from('restaurant_tables').select('id, table_number').eq('restaurant_id', RESTAURANT_ID),
    db.from('tabs').select('table_id').eq('restaurant_id', RESTAURANT_ID).in('status', ['open', 'ready_to_pay']),
  ])
  if (tablesError) throw tablesError
  if (openTabsError) throw openTabsError
  const occupied = new Set((openTabs ?? []).map((t) => String(t.table_id)))
  const free = (tables ?? []).find((t) => !occupied.has(String(t.id)))
  if (!free) throw new Error('every restaurant_tables row already has an open tab -- nothing free to probe with')
  return free as { id: string; table_number: number }
}

/** Creates one tab, one order with a single item, and its order_lines row. Total is adversarial. */
async function makeOrderWithLine(orderNumber: number, itemTotal: number) {
  const table = await pickFreeTable()

  const { data: tab, error: tabError } = await db
    .from('tabs')
    .insert({ restaurant_id: RESTAURANT_ID, table_id: table.id, table_number: table.table_number, status: 'open', members: [], total: 0 })
    .select('id')
    .single()
  if (tabError || !tab?.id) throw new Error(`tab insert failed: ${tabError?.message}`)

  const item = {
    menuItemId: null,
    name: `PROBE split-rounding item ${orderNumber}`,
    priceSource: 'catalog',
    quantity: 1,
    route_to: 'kitchen',
    subtotal: itemTotal,
    tax: 0,
    taxInclusive: true,
    taxRateId: null,
    taxRatePercentage: 0,
    total: itemTotal,
    unitPrice: itemTotal,
  }

  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      firebase_restaurant_id: RESTAURANT_ID,
      tab_id: tab.id,
      table_id: table.id,
      table_number: table.table_number,
      order_number: orderNumber,
      status: 'pending',
      payment_status: 'pending',
      payment_method: 'cash',
      channel: 'pos',
      items: [item],
      subtotal: itemTotal,
      tax: 0,
      total: itemTotal,
      is_closed: false,
      placed_at: new Date().toISOString(),
    })
    .select('id, items, total')
    .single()
  if (orderError || !order?.id) throw new Error(`order insert failed: ${orderError?.message}`)

  const { data: line, error: lineError } = await db
    .from('order_lines')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_id: order.id,
      tab_id: tab.id,
      source_item_index: 0,
      name_snapshot: item.name,
      quantity: 1,
      route_to: 'kitchen',
      kitchen_state: 'outstanding',
      bar_state: null,
    })
    .select('id')
    .single()
  if (lineError || !line?.id) throw new Error(`line insert failed: ${lineError?.message}`)

  return { tabId: String(tab.id), orderId: String(order.id), lineId: String(line.id), orderSnapshot: order }
}

async function cleanup(tabIds: string[]) {
  const { data: allocations } = await db.from('order_line_allocations').select('id').in('tab_id', tabIds)
  const allocationIds = (allocations ?? []).map((a) => String(a.id))
  if (allocationIds.length) {
    await db.from('order_line_allocation_settlements').delete().in('order_line_allocation_id', allocationIds)
    await db.from('order_line_allocations').delete().in('id', allocationIds)
  }
  const { data: lines } = await db.from('order_lines').select('id').in('tab_id', tabIds)
  const lineIds = (lines ?? []).map((l) => String(l.id))
  if (lineIds.length) await db.from('order_line_events').delete().in('order_line_id', lineIds)
  await db.from('order_lines').delete().in('tab_id', tabIds)
  await db.from('orders').delete().in('tab_id', tabIds)
  await db.from('tabs').delete().in('id', tabIds)
}

// ============================================================================================
// CLAIM 1 + 2: exact reconstruction, and no premature "paid", across a deliberately non-even
// 7-way split of an order that does not divide cleanly.
// ============================================================================================
async function proveExactReconstructionAndNoPrematurePaid(): Promise<string[]> {
  console.log('\n=== CLAIM 1+2: exact reconstruction, no premature "paid" (7-way adversarial split) ===')
  const ITEM_TOTAL = 100.07 // 10007 cents -- deliberately does not divide evenly by 7
  const { tabId, orderId, lineId } = await makeOrderWithLine(810001, ITEM_TOTAL)

  const shares = ['diner-a', 'diner-b', 'diner-c', 'diner-d', 'diner-e', 'diner-f', 'diner-g']
  const split = splitCentsByWeight(
    10007,
    shares.map((key) => ({ key, weight: 1 })),
  )
  assertTrue(sumCents(split.map((s) => s.amountCents)) === 10007, 'split shares sum to 10007 cents in memory before any write')

  const rows = split.map((s) => ({
    restaurant_id: RESTAURANT_ID,
    order_id: orderId,
    order_line_id: lineId,
    tab_id: tabId,
    allocated_to: s.key,
    quantity_allocated: 1,
    amount_cents: s.amountCents,
    created_by_actor_kind: 'system' as const,
    created_by_actor_user_id: null,
  }))
  const { data: inserted, error: insertError } = await db.from('order_line_allocations').insert(rows).select('id, amount_cents')
  if (insertError) throw insertError
  const allocationIds = (inserted ?? []).map((r) => String(r.id))

  // CLAIM 1, read back from the database, not from memory.
  const { data: readBack, error: readBackError } = await db
    .from('order_line_allocations')
    .select('amount_cents')
    .eq('order_line_id', lineId)
    .is('voided_at', null)
  if (readBackError) throw readBackError
  const readBackSum = sumCents((readBack ?? []).map((r) => Number(r.amount_cents)))
  assertTrue(readBackSum === 10007, `allocations read back from Postgres sum to exactly 10007 cents (got ${readBackSum})`)

  // CLAIM 2: settle six of the seven, asserting fully-paid is false after EACH ONE.
  for (let i = 0; i < allocationIds.length - 1; i += 1) {
    const { data: settleData, error: settleError } = await db.rpc('settle_order_line_allocations', {
      p_restaurant_id: RESTAURANT_ID,
      p_tab_id: tabId,
      p_allocation_ids: [allocationIds[i]],
      p_method: 'cash',
      p_payment_reference: `PROBE-${i}`,
      p_staff_user_id: null,
    })
    if (settleError) throw settleError
    assertTrue((settleData.applied ?? []).length === 1, `settlement ${i + 1}/7 applied`)

    const { data: fullyPaid, error: fullyPaidError } = await db.rpc('order_is_fully_paid_by_allocations', { p_order_id: orderId })
    if (fullyPaidError) throw fullyPaidError
    assertTrue(
      fullyPaid === false,
      `after settling ${i + 1}/7 shares, order_is_fully_paid_by_allocations() is FALSE (not misread as paid)`,
    )

    // Cross-check against the pure JS predicate summing the SAME settled rows read back live.
    const { data: settled } = await db
      .from('order_line_allocations')
      .select('amount_cents')
      .eq('order_line_id', lineId)
      .is('voided_at', null)
      .not('settled_at', 'is', null)
    const paidSoFar = sumCents((settled ?? []).map((r) => Number(r.amount_cents)))
    assertTrue(
      isFullyPaidCents(paidSoFar, 10007) === false,
      `lib/billing/split-cents.ts's own isFullyPaidCents() agrees: ${paidSoFar}/10007 is not fully paid`,
    )
  }

  // Settle the FINAL allocation -- only now must it flip to true.
  const lastId = allocationIds[allocationIds.length - 1]
  const { data: finalSettle, error: finalSettleError } = await db.rpc('settle_order_line_allocations', {
    p_restaurant_id: RESTAURANT_ID,
    p_tab_id: tabId,
    p_allocation_ids: [lastId],
    p_method: 'cash',
    p_payment_reference: 'PROBE-final',
    p_staff_user_id: null,
  })
  if (finalSettleError) throw finalSettleError
  assertTrue((finalSettle.applied ?? []).length === 1, 'final (7th) settlement applied')

  const { data: fullyPaidAfterLast, error: fullyPaidAfterLastError } = await db.rpc('order_is_fully_paid_by_allocations', {
    p_order_id: orderId,
  })
  if (fullyPaidAfterLastError) throw fullyPaidAfterLastError
  assertTrue(fullyPaidAfterLast === true, 'after the 7th and final settlement, order_is_fully_paid_by_allocations() is TRUE')

  const { data: settledAll } = await db
    .from('order_line_allocations')
    .select('amount_cents')
    .eq('order_line_id', lineId)
    .is('voided_at', null)
    .not('settled_at', 'is', null)
  const totalPaid = sumCents((settledAll ?? []).map((r) => Number(r.amount_cents)))
  assertTrue(totalPaid === 10007, `every settled allocation summed together is EXACTLY 10007 cents, no leftover, none double-counted (got ${totalPaid})`)

  return [tabId]
}

// ============================================================================================
// CLAIM 3: concurrent settlement of the SAME allocation cannot double-count it.
// ============================================================================================
async function proveNoDoubleCountingUnderConcurrency(): Promise<string[]> {
  console.log('\n=== CLAIM 3: concurrent settle of the SAME allocation cannot double-count ===')
  const { tabId, orderId, lineId } = await makeOrderWithLine(810002, 50.0)

  const { data: allocRow, error: allocError } = await db
    .from('order_line_allocations')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_id: orderId,
      order_line_id: lineId,
      tab_id: tabId,
      allocated_to: 'contested-diner',
      quantity_allocated: 1,
      amount_cents: 5000,
      created_by_actor_kind: 'system',
      created_by_actor_user_id: null,
    })
    .select('id')
    .single()
  if (allocError || !allocRow?.id) throw new Error(`allocation insert failed: ${allocError?.message}`)
  const allocationId = String(allocRow.id)

  const settleOnce = () =>
    db.rpc('settle_order_line_allocations', {
      p_restaurant_id: RESTAURANT_ID,
      p_tab_id: tabId,
      p_allocation_ids: [allocationId],
      p_method: 'cash',
      p_payment_reference: 'PROBE-race',
      p_staff_user_id: null,
    })

  const [a, b] = await Promise.all([settleOnce(), settleOnce()])
  if (a.error) throw a.error
  if (b.error) throw b.error

  const appliedCount = (a.data.applied ?? []).length + (b.data.applied ?? []).length
  const refusedCount = (a.data.refused ?? []).length + (b.data.refused ?? []).length
  assertTrue(appliedCount === 1, `exactly ONE of two concurrent settle calls on the same allocation applied (got ${appliedCount})`)
  assertTrue(refusedCount === 1, `exactly ONE was refused (got ${refusedCount})`)

  const { data: ledgerRows, error: ledgerError } = await db
    .from('order_line_allocation_settlements')
    .select('amount_cents')
    .eq('order_line_allocation_id', allocationId)
  if (ledgerError) throw ledgerError
  assertTrue((ledgerRows ?? []).length === 1, `the append-only ledger holds exactly ONE settlement row for this allocation (got ${(ledgerRows ?? []).length})`)
  const ledgerSum = sumCents((ledgerRows ?? []).map((r) => Number(r.amount_cents)))
  assertTrue(ledgerSum === 5000, `the one ledger row is for the full, correct amount, 5000 cents (got ${ledgerSum})`)

  return [tabId]
}

// ============================================================================================
// CLAIM 4: the order flips to paid exactly once, and its own total/items are unchanged.
// ============================================================================================
async function proveOrderFlipsOnceAndFieldsUnchanged(): Promise<string[]> {
  console.log('\n=== CLAIM 4: order flips to paid exactly once, total/items unchanged ===')
  const { tabId, orderId, lineId, orderSnapshot } = await makeOrderWithLine(810003, 33.33)
  const originalTotal = Number(orderSnapshot.total)
  const originalItems = JSON.stringify(orderSnapshot.items)

  const { data: allocRow, error: allocError } = await db
    .from('order_line_allocations')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_id: orderId,
      order_line_id: lineId,
      tab_id: tabId,
      allocated_to: 'solo-diner',
      quantity_allocated: 1,
      amount_cents: 3333,
      created_by_actor_kind: 'system',
      created_by_actor_user_id: null,
    })
    .select('id')
    .single()
  if (allocError || !allocRow?.id) throw new Error(`allocation insert failed: ${allocError?.message}`)

  const { error: settleError } = await db.rpc('settle_order_line_allocations', {
    p_restaurant_id: RESTAURANT_ID,
    p_tab_id: tabId,
    p_allocation_ids: [String(allocRow.id)],
    p_method: 'cash',
    p_payment_reference: 'PROBE-flip',
    p_staff_user_id: null,
  })
  if (settleError) throw settleError

  const { data: fullyPaid, error: fullyPaidError } = await db.rpc('order_is_fully_paid_by_allocations', { p_order_id: orderId })
  if (fullyPaidError) throw fullyPaidError
  assertTrue(fullyPaid === true, 'single-allocation order is fully paid after its one settlement')

  // The route itself performs this UPDATE...WHERE payment_status <> 'paid'; reproduced here so
  // this probe proves the SQL-level guard is real, independent of the route's own TS logic.
  const paidAt = new Date().toISOString()
  const { data: firstClaim, error: firstClaimError } = await db
    .from('orders')
    .update({ payment_status: 'paid', status: 'completed', paid_at: paidAt, completed_at: paidAt, payment_method: 'cash' })
    .eq('id', orderId)
    .eq('restaurant_id', RESTAURANT_ID)
    .not('payment_status', 'eq', 'paid')
    .select('id')
  if (firstClaimError) throw firstClaimError
  assertTrue((firstClaim ?? []).length === 1, 'first completion write claims the order')

  const { data: secondClaim, error: secondClaimError } = await db
    .from('orders')
    .update({ payment_status: 'paid', status: 'completed', paid_at: paidAt, completed_at: paidAt, payment_method: 'cash' })
    .eq('id', orderId)
    .eq('restaurant_id', RESTAURANT_ID)
    .not('payment_status', 'eq', 'paid')
    .select('id')
  if (secondClaimError) throw secondClaimError
  assertTrue((secondClaim ?? []).length === 0, 'a second completion write on the same order claims NOTHING -- the flip happens exactly once')

  const { data: finalOrder, error: finalOrderError } = await db.from('orders').select('total, items, payment_status').eq('id', orderId).single()
  if (finalOrderError) throw finalOrderError
  assertTrue(Number(finalOrder.total) === originalTotal, `orders.total is unchanged by settlement (${originalTotal} -> ${finalOrder.total})`)
  assertTrue(JSON.stringify(finalOrder.items) === originalItems, 'orders.items is byte-for-byte unchanged by settlement')
  assertTrue(finalOrder.payment_status === 'paid', 'orders.payment_status correctly reads paid')

  return [tabId]
}

async function main() {
  console.log(`=== PROVING THE ARITHMETIC CANNOT ROUND ITS WAY TO PAID, against STAGING ${STAGING_REF} ===`)

  const allTabIds: string[] = []
  try {
    allTabIds.push(...(await proveExactReconstructionAndNoPrematurePaid()))
    allTabIds.push(...(await proveNoDoubleCountingUnderConcurrency()))
    allTabIds.push(...(await proveOrderFlipsOnceAndFieldsUnchanged()))
  } finally {
    await cleanup(allTabIds)
  }

  console.log(`\n=== RESULT: ${failures === 0 ? 'ALL CLAIMS PROVEN' : `${failures} CLAIM(S) FAILED`} ===`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
