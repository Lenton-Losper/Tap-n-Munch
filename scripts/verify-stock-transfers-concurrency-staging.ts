/**
 * Staging concurrency verification for Workstream 3's dispatch_transfer:
 *
 *  Test 1 (transfer vs transfer): two dispatches racing the SAME source stock_item, combined
 *  quantity exceeding what's available. Both take the same pg_advisory_xact_lock, so Postgres
 *  should serialize them -- expect exactly one success.
 *
 *  Test 2 (transfer vs sale): a dispatch racing a sale (order completion -> deduct_recipe_stock)
 *  on the SAME stock_item. deduct_recipe_stock does not take the advisory lock dispatch_transfer
 *  uses, and has no sufficiency check of its own at all -- this is the flagged, deliberately
 *  unaddressed scope limit. Run for real across several trials and report what actually
 *  happens; do not modify deduct_recipe_stock to "fix" this without approval.
 *
 *   npx tsx scripts/verify-stock-transfers-concurrency-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!stagingUrl?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase (.env.test)')

const db = createClient(stagingUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `ws3c-${Date.now()}`
let unitGId = ''

const allCreated = {
  userIds: [] as string[],
  organizationIds: [] as string[],
  restaurantIds: [] as string[],
  orgStockItemIds: [] as string[],
  stockItemIds: [] as string[],
  transferIds: [] as string[],
  menuItemIds: [] as string[],
  recipeIds: [] as string[],
  orderIds: [] as string[],
}

async function cleanupAll() {
  if (allCreated.orderIds.length) {
    await db.from('stock_movements').delete().eq('reference_type', 'order').in('reference_id', allCreated.orderIds)
    await db.from('orders').delete().in('id', allCreated.orderIds)
  }
  if (allCreated.recipeIds.length) {
    await db.from('recipe_items').delete().in('recipe_id', allCreated.recipeIds)
    await db.from('recipes').delete().in('id', allCreated.recipeIds)
  }
  if (allCreated.menuItemIds.length) {
    await db.from('menu_items').delete().in('id', allCreated.menuItemIds)
  }
  if (allCreated.transferIds.length) {
    await db.from('stock_movements').delete().eq('reference_type', 'stock_transfer').in('reference_id', allCreated.transferIds)
    await db.from('stock_transfer_items').delete().in('transfer_id', allCreated.transferIds)
    await db.from('stock_transfers').delete().in('id', allCreated.transferIds)
  }
  if (allCreated.stockItemIds.length) {
    await db.from('stock_movements').delete().in('stock_item_id', allCreated.stockItemIds)
    await db.from('stock_items').delete().in('id', allCreated.stockItemIds)
  }
  if (allCreated.orgStockItemIds.length) {
    await db.from('organization_stock_items').delete().in('id', allCreated.orgStockItemIds)
  }
  if (allCreated.restaurantIds.length) {
    await db.from('restaurants').delete().in('id', allCreated.restaurantIds)
  }
  if (allCreated.organizationIds.length) {
    await db.from('organizations').delete().in('id', allCreated.organizationIds)
  }
  if (allCreated.userIds.length) {
    await db.from('users').delete().in('id', allCreated.userIds)
    for (const id of allCreated.userIds) {
      await db.auth.admin.deleteUser(id).catch(() => {})
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function createRealAuthUser(emailTag: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `${tag}-${emailTag}@flashtap-test.invalid`,
    password: `P${randomUUID()}!1`,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  allCreated.userIds.push(userId)
  const { error: publicUserError } = await db.from('users').insert({ id: userId, email: data.user.email })
  if (publicUserError) throw publicUserError
  return userId
}

async function createOrgWithTwoRestaurants(suffix: string) {
  const ownerUserId = await createRealAuthUser(`owner-${suffix}`)
  const { data: org, error: orgError } = await db
    .from('organizations')
    .insert({ name: `${tag} Org ${suffix}`, owner_user_id: ownerUserId })
    .select('id')
    .single()
  if (orgError || !org) throw orgError ?? new Error('org insert failed')
  allCreated.organizationIds.push(org.id)

  const { data: restA, error: restAError } = await db
    .from('restaurants')
    .insert({ name: `${tag} ${suffix} A`, organization_id: org.id })
    .select('id')
    .single()
  if (restAError || !restA) throw restAError ?? new Error('restaurant A insert failed')
  allCreated.restaurantIds.push(restA.id)

  const { data: restB, error: restBError } = await db
    .from('restaurants')
    .insert({ name: `${tag} ${suffix} B`, organization_id: org.id })
    .select('id')
    .single()
  if (restBError || !restB) throw restBError ?? new Error('restaurant B insert failed')
  allCreated.restaurantIds.push(restB.id)

  return { organizationId: org.id as string, restaurantAId: restA.id as string, restaurantBId: restB.id as string, ownerUserId }
}

async function createOrgStockItem(organizationId: string, name: string): Promise<string> {
  const { data, error } = await db
    .from('organization_stock_items')
    .insert({ organization_id: organizationId, name, base_unit_id: unitGId })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('org stock item insert failed')
  allCreated.orgStockItemIds.push(data.id)
  return data.id
}

async function createLocalStockItem(restaurantId: string, orgStockItemId: string, name: string): Promise<string> {
  const { data, error } = await db
    .from('stock_items')
    .insert({ restaurant_id: restaurantId, organization_stock_item_id: orgStockItemId, name, unit_id: unitGId, is_active: true })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('local stock item insert failed')
  allCreated.stockItemIds.push(data.id)
  return data.id
}

async function addStock(restaurantId: string, stockItemId: string, quantity: number) {
  const { error } = await db.from('stock_movements').insert({ restaurant_id: restaurantId, stock_item_id: stockItemId, quantity_delta: quantity, reason: 'received' })
  if (error) throw error
}

async function balanceOf(stockItemId: string): Promise<number> {
  const { data, error } = await db.from('stock_movements').select('quantity_delta').eq('stock_item_id', stockItemId)
  if (error) throw error
  return (data ?? []).reduce((sum, row) => sum + Number(row.quantity_delta), 0)
}

async function createDraftTransfer(params: {
  organizationId: string
  fromRestaurantId: string
  toRestaurantId: string
  createdBy: string
  organizationStockItemId: string
  quantitySent: number
}): Promise<string> {
  const { data: transfer, error: transferError } = await db
    .from('stock_transfers')
    .insert({ organization_id: params.organizationId, from_restaurant_id: params.fromRestaurantId, to_restaurant_id: params.toRestaurantId, created_by: params.createdBy })
    .select('id')
    .single()
  if (transferError || !transfer) throw transferError ?? new Error('transfer insert failed')
  allCreated.transferIds.push(transfer.id)

  const { error: itemsError } = await db
    .from('stock_transfer_items')
    .insert({ transfer_id: transfer.id, organization_stock_item_id: params.organizationStockItemId, quantity_sent: params.quantitySent, unit_id: unitGId })
  if (itemsError) throw itemsError

  return transfer.id as string
}

// ============================================================
// Test 1: transfer vs transfer on the same source item
// ============================================================
async function runConcurrencyTest1() {
  console.log('--- Concurrency test 1: two dispatches racing the same source item ---')

  const org = await createOrgWithTwoRestaurants('t1')
  const orgItem = await createOrgStockItem(org.organizationId, `${tag} coffee`)
  const sourceStockItem = await createLocalStockItem(org.restaurantAId, orgItem, `${tag} coffee`)
  await createLocalStockItem(org.restaurantBId, orgItem, `${tag} coffee`)
  await addStock(org.restaurantAId, sourceStockItem, 10)

  const transferX = await createDraftTransfer({
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    createdBy: org.ownerUserId,
    organizationStockItemId: orgItem,
    quantitySent: 6,
  })
  const transferY = await createDraftTransfer({
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    createdBy: org.ownerUserId,
    organizationStockItemId: orgItem,
    quantitySent: 6,
  })

  console.log(`source balance before: 10. transfer X wants 6, transfer Y wants 6 (combined 12 > 10). Firing both dispatch_transfer calls concurrently...`)

  const [resultX, resultY] = await Promise.allSettled([
    db.rpc('dispatch_transfer', { p_transfer_id: transferX, p_user_id: org.ownerUserId }),
    db.rpc('dispatch_transfer', { p_transfer_id: transferY, p_user_id: org.ownerUserId }),
  ])

  const outcomeOf = (r: PromiseSettledResult<{ error: { message: string } | null }>) => {
    if (r.status === 'rejected') return { ok: false, message: String(r.reason) }
    if (r.value.error) return { ok: false, message: r.value.error.message }
    return { ok: true, message: null as string | null }
  }
  const oX = outcomeOf(resultX as any)
  const oY = outcomeOf(resultY as any)

  console.log(`transfer X: ${oX.ok ? 'SUCCEEDED' : `FAILED (${oX.message})`}`)
  console.log(`transfer Y: ${oY.ok ? 'SUCCEEDED' : `FAILED (${oY.message})`}`)

  const successCount = [oX, oY].filter((o) => o.ok).length
  assert(successCount === 1, `expected exactly 1 of the 2 racing dispatches to succeed, got ${successCount}`)

  const finalBalance = await balanceOf(sourceStockItem)
  assert(finalBalance === 4, `expected final balance 4 (10 - one successful 6), got ${finalBalance}`)

  console.log(`RESULT: exactly one dispatch succeeded, final balance = ${finalBalance} (10 - 6). The advisory lock correctly serialized the two racing transfers -- CONFIRMED SAFE.`)
}

// ============================================================
// Test 2: transfer vs sale on the same stock item
// ============================================================
async function setupSaleFixture(restaurantId: string, stockItemId: string, deductQty: number) {
  const { data: menuItem, error: menuItemError } = await db
    .from('menu_items')
    .insert({ restaurant_id: restaurantId, name: `${tag} menu item`, base_price: 10, status: 'active' })
    .select('id')
    .single()
  if (menuItemError || !menuItem) throw menuItemError ?? new Error('menu item insert failed')
  allCreated.menuItemIds.push(menuItem.id)

  const { data: recipe, error: recipeError } = await db
    .from('recipes')
    .insert({ restaurant_id: restaurantId, menu_item_id: menuItem.id, name: `${tag} recipe`, is_active: true })
    .select('id')
    .single()
  if (recipeError || !recipe) throw recipeError ?? new Error('recipe insert failed')
  allCreated.recipeIds.push(recipe.id)

  const { error: recipeItemError } = await db
    .from('recipe_items')
    .insert({ recipe_id: recipe.id, stock_item_id: stockItemId, quantity: deductQty, unit_id: unitGId })
  if (recipeItemError) throw recipeItemError

  const orderNumber = 970_000 + (Date.now() % 10_000)
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: restaurantId,
      order_number: orderNumber,
      table_number: 88,
      status: 'accepted',
      payment_status: 'unpaid',
      total: 10,
      items: [{ menu_item_id: menuItem.id, name: `${tag} menu item`, quantity: 1, price: 10 }],
    })
    .select('id')
    .single()
  if (orderError || !order) throw orderError ?? new Error('order insert failed')
  allCreated.orderIds.push(order.id)

  return order.id as string
}

async function runConcurrencyTest2Trial(trialIndex: number): Promise<{ dispatchOk: boolean; saleFired: boolean; finalBalance: number; startBalance: number }> {
  const org = await createOrgWithTwoRestaurants(`t2-${trialIndex}`)
  const orgItem = await createOrgStockItem(org.organizationId, `${tag} milk-${trialIndex}`)
  const sourceStockItem = await createLocalStockItem(org.restaurantAId, orgItem, `${tag} milk-${trialIndex}`)
  await createLocalStockItem(org.restaurantBId, orgItem, `${tag} milk-${trialIndex}`)

  const startBalance = 8
  await addStock(org.restaurantAId, sourceStockItem, startBalance)

  const transfer = await createDraftTransfer({
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    createdBy: org.ownerUserId,
    organizationStockItemId: orgItem,
    quantitySent: 8,
  })

  const orderId = await setupSaleFixture(org.restaurantAId, sourceStockItem, 8)

  // Fire the sale (order completion) and the dispatch as close together as possible.
  const salePromise = db.from('orders').update({ status: 'completed' }).eq('id', orderId).select('id').single()
  const dispatchPromise = db.rpc('dispatch_transfer', { p_transfer_id: transfer, p_user_id: org.ownerUserId })

  const [saleResult, dispatchResult] = await Promise.allSettled([salePromise, dispatchPromise])

  const saleFired = saleResult.status === 'fulfilled' && !(saleResult.value as any).error
  const dispatchOk = dispatchResult.status === 'fulfilled' && !(dispatchResult.value as any).error

  const finalBalance = await balanceOf(sourceStockItem)

  return { dispatchOk, saleFired, finalBalance, startBalance }
}

async function runConcurrencyTest2() {
  console.log('\n--- Concurrency test 2: dispatch vs sale on the same stock item ---')
  console.log('deduct_recipe_stock does not take the pg_advisory_xact_lock dispatch_transfer uses, and has')
  console.log('no sufficiency check of its own. Running multiple trials to see if this actually manifests.')

  const TRIALS = 8
  let raceObserved = false
  const trialResults: string[] = []

  for (let i = 0; i < TRIALS; i++) {
    const r = await runConcurrencyTest2Trial(i)
    const isImpossible = r.finalBalance < 0
    if (isImpossible) raceObserved = true
    trialResults.push(
      `  trial ${i}: start=${r.startBalance} dispatch=${r.dispatchOk ? 'ok' : 'rejected'} sale=${r.saleFired ? 'fired' : 'failed'} final=${r.finalBalance}${isImpossible ? '  <-- IMPOSSIBLE NEGATIVE BALANCE (race manifested)' : ''}`,
    )
  }

  console.log(trialResults.join('\n'))

  if (raceObserved) {
    console.log(
      '\nRESULT: the race DID manifest at least once -- a dispatch and a sale both posted against the same\n' +
        'stock_item, producing a negative balance that should have been impossible. This confirms the flagged\n' +
        'scope limit is real: pg_advisory_xact_lock in dispatch_transfer does NOT protect against a concurrent\n' +
        'sale, because deduct_recipe_stock never takes that lock (and has no sufficiency check of its own).\n' +
        'NOT fixed here -- deduct_recipe_stock requires zero changes per the architecture; flagging for a decision.',
    )
  } else {
    console.log(
      '\nRESULT: no negative balance observed in these trials. This does NOT mean the gap is safe -- it means\n' +
        'the specific timing needed to trigger it did not land in these runs. The structural gap is still real:\n' +
        'deduct_recipe_stock takes no lock and has no sufficiency check, so nothing prevents this interleaving\n' +
        'in general, only this particular test run got lucky. Treat the scope limit as unresolved regardless.',
    )
  }
}

async function main() {
  const { data: gUnit, error: gUnitError } = await db.from('measurement_units').select('id').is('restaurant_id', null).eq('name', 'g').single()
  if (gUnitError || !gUnit) throw gUnitError ?? new Error('system unit "g" missing')
  unitGId = gUnit.id

  await runConcurrencyTest1()
  await runConcurrencyTest2()

  console.log('\nWS3_CONCURRENCY_STAGING_VERIFY_DONE')
  await cleanupAll()
}

main().catch(async (error) => {
  console.error('WS3_CONCURRENCY_STAGING_VERIFY_FAIL', error)
  try {
    await cleanupAll()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
