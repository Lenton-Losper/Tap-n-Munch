/**
 * Staging verification for Per-item VAT Phase C (server-side order pricing/tax calculation).
 * Exercises the real, deployed-identical code paths directly against staging Supabase --
 * no HTTP server needed since Next.js route handlers are plain async functions:
 *  - calculateOrderPricing() in isolation: mixed Standard(15%,incl.)+Zero-rated(0%) cart,
 *    and a restaurant with zero tax rates configured (must behave exactly as pre-Phase-C: 0%).
 *  - the real POST handler in app/api/orders/route.ts (kiosk channel, no table/tab needed):
 *    submits a deliberately wrong client subtotal/total and asserts the stored order uses the
 *    server-recomputed values, not the client's.
 *  - the real createOrder() in lib/orders/create-order.ts (the terminal/POS path): same
 *    mismatched-client-total check.
 *
 *   npx tsx scripts/verify-order-tax-calculation-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
// lib/supabase/client.ts constructs a browser client at import time and throws if unset --
// that singleton is never actually queried on the code paths this script exercises.
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || SERVICE_KEY

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `taxcalc-${Date.now()}`

const created = {
  restaurantIds: [] as string[],
  categoryIds: [] as string[],
  menuItemIds: [] as string[],
  taxRateIds: [] as string[],
  orderIds: [] as string[],
}

async function cleanup() {
  if (process.env.PW_SKIP_CLEANUP) {
    console.log('PW_SKIP_CLEANUP set -- leaving fixtures in place for inspection:', JSON.stringify(created))
    return
  }
  if (created.orderIds.length) await db.from('orders').delete().in('id', created.orderIds)
  if (created.menuItemIds.length) await db.from('menu_items').delete().in('id', created.menuItemIds)
  if (created.categoryIds.length) await db.from('menu_categories').delete().in('id', created.categoryIds)
  if (created.taxRateIds.length) await db.from('tax_rates').delete().in('id', created.taxRateIds)
  if (created.restaurantIds.length) await db.from('restaurants').delete().in('id', created.restaurantIds)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 0.005, `${message} (expected ${expected}, got ${actual})`)
}

async function main() {
  // ============================================================
  // Fixtures: Restaurant A (tax rates configured, mixed cart), Restaurant B (no tax rates).
  // ============================================================
  const { data: restaurantA, error: restaurantAError } = await db
    .from('restaurants')
    .insert({ name: `${tag} A (with tax rates)` })
    .select('id')
    .single()
  if (restaurantAError || !restaurantA) throw restaurantAError ?? new Error('restaurant A insert failed')
  created.restaurantIds.push(restaurantA.id)

  const { data: restaurantB, error: restaurantBError } = await db
    .from('restaurants')
    .insert({ name: `${tag} B (no tax rates)` })
    .select('id')
    .single()
  if (restaurantBError || !restaurantB) throw restaurantBError ?? new Error('restaurant B insert failed')
  created.restaurantIds.push(restaurantB.id)

  const { data: standardRate, error: standardRateError } = await db
    .from('tax_rates')
    .insert({ restaurant_id: restaurantA.id, name: 'Standard', percentage: 15, is_inclusive: true, is_default: true })
    .select('id')
    .single()
  if (standardRateError || !standardRate) throw standardRateError ?? new Error('standard rate insert failed')
  created.taxRateIds.push(standardRate.id)

  const { data: zeroRate, error: zeroRateError } = await db
    .from('tax_rates')
    .insert({ restaurant_id: restaurantA.id, name: 'Zero-rated', percentage: 0, is_inclusive: true, is_default: false })
    .select('id')
    .single()
  if (zeroRateError || !zeroRate) throw zeroRateError ?? new Error('zero rate insert failed')
  created.taxRateIds.push(zeroRate.id)

  const { data: categoryA, error: categoryAError } = await db
    .from('menu_categories')
    .insert({ restaurant_id: restaurantA.id, name: `${tag} Category A` })
    .select('id')
    .single()
  if (categoryAError || !categoryA) throw categoryAError ?? new Error('category A insert failed')
  created.categoryIds.push(categoryA.id)

  const { data: categoryB, error: categoryBError } = await db
    .from('menu_categories')
    .insert({ restaurant_id: restaurantB.id, name: `${tag} Category B` })
    .select('id')
    .single()
  if (categoryBError || !categoryB) throw categoryBError ?? new Error('category B insert failed')
  created.categoryIds.push(categoryB.id)

  const { data: steakItem, error: steakItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: restaurantA.id,
      category_id: categoryA.id,
      name: `${tag} Grilled Steak`,
      base_price: 200,
      tax_rate_id: standardRate.id,
    })
    .select('id')
    .single()
  if (steakItemError || !steakItem) throw steakItemError ?? new Error('steak item insert failed')
  created.menuItemIds.push(steakItem.id)

  const { data: saladItem, error: saladItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: restaurantA.id,
      category_id: categoryA.id,
      name: `${tag} Salad`,
      base_price: 50,
      tax_rate_id: zeroRate.id,
    })
    .select('id')
    .single()
  if (saladItemError || !saladItem) throw saladItemError ?? new Error('salad item insert failed')
  created.menuItemIds.push(saladItem.id)

  const { data: burgerItem, error: burgerItemError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: restaurantB.id,
      category_id: categoryB.id,
      name: `${tag} Plain Burger`,
      base_price: 80,
    })
    .select('id')
    .single()
  if (burgerItemError || !burgerItem) throw burgerItemError ?? new Error('burger item insert failed')
  created.menuItemIds.push(burgerItem.id)

  console.log('Fixtures created: restaurant A (Standard 15% incl. default + Zero-rated 0%), restaurant B (no tax rates) -- OK')

  // ============================================================
  // Part 1: calculateOrderPricing() in isolation -- mixed-rate cart.
  // Grilled Steak x2 @ 200 (15% incl.) -> line 400, tax 52.17, net 347.83
  // Salad x1 @ 50 (0%)                -> line 50,  tax 0,     net 50
  // Order: subtotal 397.83, tax 52.17, total 450.00
  // ============================================================
  console.log('\n--- Part 1: calculateOrderPricing, mixed Standard + Zero-rated cart ---')
  const { calculateOrderPricing } = await import('../lib/orders/calculate-order-pricing')

  const mixedResult = await calculateOrderPricing(db as any, restaurantA.id, [
    { menuItemId: steakItem.id, quantity: 2, subtotal: 1 },
    { menuItemId: saladItem.id, quantity: 1, subtotal: 1 },
  ])
  assertClose(mixedResult.subtotal, 397.83, 'mixed cart subtotal')
  assertClose(mixedResult.tax, 52.17, 'mixed cart tax')
  assertClose(mixedResult.total, 450.0, 'mixed cart total')
  assertClose(mixedResult.subtotal + mixedResult.tax, mixedResult.total, 'subtotal + tax === total')
  console.log(`Mixed cart: subtotal=${mixedResult.subtotal} tax=${mixedResult.tax} total=${mixedResult.total} -- OK`)

  // ============================================================
  // Part 2: restaurant with zero tax rates configured -- must behave exactly as before.
  // Plain Burger x3 @ 80 -> subtotal 240, tax 0, total 240
  // ============================================================
  console.log('\n--- Part 2: calculateOrderPricing, restaurant with no tax rates configured ---')
  const noTaxResult = await calculateOrderPricing(db as any, restaurantB.id, [
    { menuItemId: burgerItem.id, quantity: 3, subtotal: 1 },
  ])
  assertClose(noTaxResult.subtotal, 240, 'no-tax-restaurant subtotal')
  assertClose(noTaxResult.tax, 0, 'no-tax-restaurant tax')
  assertClose(noTaxResult.total, 240, 'no-tax-restaurant total')
  console.log(`No tax rates: subtotal=${noTaxResult.subtotal} tax=${noTaxResult.tax} total=${noTaxResult.total} -- OK (0% clean, no errors)`)

  // ============================================================
  // Part 3: the real POST /api/orders handler, kiosk channel, deliberately wrong client total.
  // ============================================================
  console.log('\n--- Part 3: real app/api/orders POST handler, mismatched client total ---')
  const { POST: ordersPost } = await import('../app/api/orders/route')

  const wrongClientRequest = new Request('https://staging.invalid/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      restaurantId: restaurantA.id,
      tableNumber: 0,
      channel: 'kiosk',
      items: [
        { menuItemId: steakItem.id, name: 'Grilled Steak', quantity: 2 },
        { menuItemId: saladItem.id, name: 'Salad', quantity: 1 },
      ],
      subtotal: 1, // deliberately wrong
      total: 1, // deliberately wrong
    }),
  })

  const ordersResponse = await ordersPost(wrongClientRequest)
  const ordersBody = (await ordersResponse.json()) as { success?: boolean; orderId?: string; error?: string }
  assert(ordersResponse.status === 200 && ordersBody.success, `expected /api/orders to succeed, got ${JSON.stringify(ordersBody)}`)
  assert(ordersBody.orderId, 'expected orderId in response')
  created.orderIds.push(ordersBody.orderId!)

  const { data: storedOrder, error: storedOrderError } = await db
    .from('orders')
    .select('subtotal, tax, total')
    .eq('id', ordersBody.orderId!)
    .single()
  if (storedOrderError || !storedOrder) throw storedOrderError ?? new Error('stored order fetch failed')

  assertClose(Number(storedOrder.subtotal), 397.83, 'stored order subtotal (server, not client)')
  assertClose(Number(storedOrder.tax), 52.17, 'stored order tax (server, not client)')
  assertClose(Number(storedOrder.total), 450.0, 'stored order total (server, not client)')
  assert(Number(storedOrder.total) !== 1, 'stored total must NOT be the client-submitted wrong value')
  console.log(
    `Client submitted subtotal=1 total=1 (wrong); stored order has subtotal=${storedOrder.subtotal} tax=${storedOrder.tax} total=${storedOrder.total} -- server won -- OK`,
  )

  // ============================================================
  // Part 4: the real createOrder() helper (terminal/POS path), mismatched client total.
  // ============================================================
  console.log('\n--- Part 4: real lib/orders/create-order.ts createOrder(), mismatched client total ---')
  const { createOrder } = await import('../lib/orders/create-order')

  const terminalResult = await createOrder({
    restaurantId: restaurantA.id,
    firebaseRestaurantId: restaurantA.id,
    tableNumber: 0,
    tableId: null,
    sessionId: null,
    items: [
      { menuItemId: steakItem.id, name: 'Grilled Steak', quantity: 2 },
      { menuItemId: saladItem.id, name: 'Salad', quantity: 1 },
    ],
    subtotal: 1, // deliberately wrong
    total: 1, // deliberately wrong
    paymentMethod: 'card',
    paymentChannel: 'card_manual',
    paymentStatus: 'pending',
    orderInstructions: null,
    tabId: null,
    channel: 'pos',
    customerName: null,
    idempotencyKey: null,
    memberSessionId: null,
    tabSettlementForTabId: null,
    isClosed: true,
  })
  created.orderIds.push(terminalResult.orderId)

  const { data: storedTerminalOrder, error: storedTerminalOrderError } = await db
    .from('orders')
    .select('subtotal, tax, total')
    .eq('id', terminalResult.orderId)
    .single()
  if (storedTerminalOrderError || !storedTerminalOrder) throw storedTerminalOrderError ?? new Error('stored terminal order fetch failed')

  assertClose(Number(storedTerminalOrder.subtotal), 397.83, 'terminal order subtotal (server, not client)')
  assertClose(Number(storedTerminalOrder.tax), 52.17, 'terminal order tax (server, not client)')
  assertClose(Number(storedTerminalOrder.total), 450.0, 'terminal order total (server, not client)')
  console.log(
    `Terminal path: client submitted subtotal=1 total=1 (wrong); stored order has subtotal=${storedTerminalOrder.subtotal} tax=${storedTerminalOrder.tax} total=${storedTerminalOrder.total} -- server won -- OK`,
  )

  console.log('\nORDER_TAX_CALCULATION_STAGING_VERIFY_OK')
}

main()
  .catch(async (error) => {
    console.error('ORDER_TAX_CALCULATION_STAGING_VERIFY_FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
