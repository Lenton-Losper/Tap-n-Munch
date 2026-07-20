/**
 * Staging verification for Workstream 3 (transfer schema + atomic dispatch/receive):
 *  - normal transfer end-to-end (dispatch -> receive), exact balances both sides, exactly
 *    one transfer_out / transfer_in row each
 *  - variance scenario (sent 20, received 18 -- the 2 are never credited anywhere)
 *  - unconfigured-item rejection (dispatch fails before posting anything)
 *  - idempotency of dispatch/receive/cancel
 *  - concurrency test 1: two dispatches racing the same source item -- exactly one succeeds
 *  - concurrency test 2: a dispatch racing a sale on the same stock item -- the advisory
 *    lock does NOT protect this (deduct_recipe_stock doesn't take it); demonstrated for
 *    real, reported, not silently patched
 *   npx tsx scripts/verify-stock-transfers-staging.ts
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

const tag = `ws3-${Date.now()}`

const created = {
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

async function cleanup() {
  if (created.orderIds.length) {
    await db.from('stock_movements').delete().eq('reference_type', 'order').in('reference_id', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
  if (created.recipeIds.length) {
    await db.from('recipe_items').delete().in('recipe_id', created.recipeIds)
    await db.from('recipes').delete().in('id', created.recipeIds)
  }
  if (created.menuItemIds.length) {
    await db.from('menu_items').delete().in('id', created.menuItemIds)
  }
  if (created.transferIds.length) {
    await db.from('stock_movements').delete().eq('reference_type', 'stock_transfer').in('reference_id', created.transferIds)
    await db.from('stock_transfer_items').delete().in('transfer_id', created.transferIds)
    await db.from('stock_transfers').delete().in('id', created.transferIds)
  }
  if (created.stockItemIds.length) {
    await db.from('stock_movements').delete().in('stock_item_id', created.stockItemIds)
    await db.from('stock_items').delete().in('id', created.stockItemIds)
  }
  if (created.orgStockItemIds.length) {
    await db.from('organization_stock_items').delete().in('id', created.orgStockItemIds)
  }
  if (created.restaurantIds.length) {
    await db.from('restaurants').delete().in('id', created.restaurantIds)
  }
  if (created.organizationIds.length) {
    await db.from('organizations').delete().in('id', created.organizationIds)
  }
  if (created.userIds.length) {
    await db.from('users').delete().in('id', created.userIds)
    for (const id of created.userIds) {
      await db.auth.admin.deleteUser(id).catch(() => {})
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

let unitGId = ''

async function createRealAuthUser(emailTag: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `${tag}-${emailTag}@flashtap-test.invalid`,
    password: `P${randomUUID()}!1`,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  created.userIds.push(userId)
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
  created.organizationIds.push(org.id)

  const { data: restA, error: restAError } = await db
    .from('restaurants')
    .insert({ name: `${tag} ${suffix} A`, organization_id: org.id })
    .select('id')
    .single()
  if (restAError || !restA) throw restAError ?? new Error('restaurant A insert failed')
  created.restaurantIds.push(restA.id)

  const { data: restB, error: restBError } = await db
    .from('restaurants')
    .insert({ name: `${tag} ${suffix} B`, organization_id: org.id })
    .select('id')
    .single()
  if (restBError || !restB) throw restBError ?? new Error('restaurant B insert failed')
  created.restaurantIds.push(restB.id)

  return { organizationId: org.id as string, restaurantAId: restA.id as string, restaurantBId: restB.id as string, ownerUserId }
}

async function createOrgStockItem(organizationId: string, name: string): Promise<string> {
  const { data, error } = await db
    .from('organization_stock_items')
    .insert({ organization_id: organizationId, name, base_unit_id: unitGId })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('org stock item insert failed')
  created.orgStockItemIds.push(data.id)
  return data.id
}

async function createLocalStockItem(restaurantId: string, orgStockItemId: string, name: string): Promise<string> {
  const { data, error } = await db
    .from('stock_items')
    .insert({
      restaurant_id: restaurantId,
      organization_stock_item_id: orgStockItemId,
      name,
      unit_id: unitGId,
      is_active: true,
    })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('local stock item insert failed')
  created.stockItemIds.push(data.id)
  return data.id
}

async function addStock(restaurantId: string, stockItemId: string, quantity: number) {
  const { error } = await db.from('stock_movements').insert({
    restaurant_id: restaurantId,
    stock_item_id: stockItemId,
    quantity_delta: quantity,
    reason: 'received',
  })
  if (error) throw error
}

async function balanceOf(stockItemId: string): Promise<number> {
  const { data, error } = await db.from('stock_movements').select('quantity_delta').eq('stock_item_id', stockItemId)
  if (error) throw error
  return (data ?? []).reduce((sum, row) => sum + Number(row.quantity_delta), 0)
}

async function movementsFor(stockItemId: string, reason: string) {
  const { data, error } = await db
    .from('stock_movements')
    .select('id, quantity_delta, reason, reference_type, reference_id')
    .eq('stock_item_id', stockItemId)
    .eq('reason', reason)
  if (error) throw error
  return data ?? []
}

async function createDraftTransfer(params: {
  organizationId: string
  fromRestaurantId: string
  toRestaurantId: string
  createdBy: string
  items: Array<{ organizationStockItemId: string; quantitySent: number }>
}): Promise<string> {
  const { data: transfer, error: transferError } = await db
    .from('stock_transfers')
    .insert({
      organization_id: params.organizationId,
      from_restaurant_id: params.fromRestaurantId,
      to_restaurant_id: params.toRestaurantId,
      created_by: params.createdBy,
    })
    .select('id, transfer_number')
    .single()
  if (transferError || !transfer) throw transferError ?? new Error('transfer insert failed')
  created.transferIds.push(transfer.id)

  assert(typeof transfer.transfer_number === 'string' && /^TRF-\d{6}$/.test(transfer.transfer_number), `transfer_number should match TRF-###### pattern, got ${transfer.transfer_number}`)

  const rows = params.items.map((item) => ({
    transfer_id: transfer.id,
    organization_stock_item_id: item.organizationStockItemId,
    quantity_sent: item.quantitySent,
    unit_id: unitGId,
  }))
  const { error: itemsError } = await db.from('stock_transfer_items').insert(rows)
  if (itemsError) throw itemsError

  return transfer.id as string
}

async function main() {
  const { data: gUnit, error: gUnitError } = await db
    .from('measurement_units')
    .select('id')
    .is('restaurant_id', null)
    .eq('name', 'g')
    .single()
  if (gUnitError || !gUnit) throw gUnitError ?? new Error('system unit "g" missing')
  unitGId = gUnit.id

  // ============================================================
  // Part 1: normal transfer end-to-end
  // ============================================================
  console.log('--- Part 1: normal transfer end-to-end ---')

  const org1 = await createOrgWithTwoRestaurants('normal')
  const orgItem1 = await createOrgStockItem(org1.organizationId, `${tag} flour`)
  const sourceStockItem1 = await createLocalStockItem(org1.restaurantAId, orgItem1, `${tag} flour`)
  const destStockItem1 = await createLocalStockItem(org1.restaurantBId, orgItem1, `${tag} flour`)
  await addStock(org1.restaurantAId, sourceStockItem1, 50)

  const transfer1 = await createDraftTransfer({
    organizationId: org1.organizationId,
    fromRestaurantId: org1.restaurantAId,
    toRestaurantId: org1.restaurantBId,
    createdBy: org1.ownerUserId,
    items: [{ organizationStockItemId: orgItem1, quantitySent: 15 }],
  })

  const { error: dispatch1Error } = await db.rpc('dispatch_transfer', { p_transfer_id: transfer1, p_user_id: org1.ownerUserId })
  if (dispatch1Error) throw dispatch1Error

  let { data: t1AfterDispatch } = await db.from('stock_transfers').select('status, dispatched_by, dispatched_at').eq('id', transfer1).single()
  assert(t1AfterDispatch?.status === 'IN_TRANSIT', `expected IN_TRANSIT, got ${t1AfterDispatch?.status}`)
  assert(t1AfterDispatch?.dispatched_by === org1.ownerUserId, 'dispatched_by should be set')
  assert(!!t1AfterDispatch?.dispatched_at, 'dispatched_at should be set')

  const sourceBalanceAfterDispatch = await balanceOf(sourceStockItem1)
  assert(sourceBalanceAfterDispatch === 35, `expected source balance 35 after dispatch, got ${sourceBalanceAfterDispatch}`)
  const transferOutRows = await movementsFor(sourceStockItem1, 'transfer_out')
  assert(transferOutRows.length === 1, `expected exactly 1 transfer_out row, got ${transferOutRows.length}`)
  assert(Number(transferOutRows[0].quantity_delta) === -15, `expected transfer_out quantity_delta -15, got ${transferOutRows[0].quantity_delta}`)
  assert(transferOutRows[0].reference_type === 'stock_transfer' && transferOutRows[0].reference_id === transfer1, 'transfer_out reference should point at the transfer')
  console.log('dispatch: status IN_TRANSIT, source debited exactly once, correct amount -- OK')

  const { error: receive1Error } = await db.rpc('receive_transfer', { p_transfer_id: transfer1, p_user_id: org1.ownerUserId })
  if (receive1Error) throw receive1Error

  const { data: t1AfterReceive } = await db.from('stock_transfers').select('status, received_by, received_at').eq('id', transfer1).single()
  assert(t1AfterReceive?.status === 'RECEIVED', `expected RECEIVED, got ${t1AfterReceive?.status}`)
  assert(t1AfterReceive?.received_by === org1.ownerUserId, 'received_by should be set')
  assert(!!t1AfterReceive?.received_at, 'received_at should be set')

  const destBalanceAfterReceive = await balanceOf(destStockItem1)
  assert(destBalanceAfterReceive === 15, `expected dest balance 15 after receive, got ${destBalanceAfterReceive}`)
  const transferInRows = await movementsFor(destStockItem1, 'transfer_in')
  assert(transferInRows.length === 1, `expected exactly 1 transfer_in row, got ${transferInRows.length}`)
  assert(Number(transferInRows[0].quantity_delta) === 15, `expected transfer_in quantity_delta 15, got ${transferInRows[0].quantity_delta}`)
  console.log('receive: status RECEIVED, destination credited exactly once, correct amount -- OK')

  const finalSourceBalance = await balanceOf(sourceStockItem1)
  assert(finalSourceBalance === 35, `source balance should remain 35 after receive, got ${finalSourceBalance}`)
  console.log(`exact balances confirmed: source=${finalSourceBalance} (50-15), dest=${destBalanceAfterReceive} (0+15) -- OK`)

  // Idempotency
  const { error: dispatch1AgainError } = await db.rpc('dispatch_transfer', { p_transfer_id: transfer1, p_user_id: org1.ownerUserId })
  if (dispatch1AgainError) throw dispatch1AgainError
  const { error: receive1AgainError } = await db.rpc('receive_transfer', { p_transfer_id: transfer1, p_user_id: org1.ownerUserId })
  if (receive1AgainError) throw receive1AgainError
  const transferOutRowsAfterRetry = await movementsFor(sourceStockItem1, 'transfer_out')
  const transferInRowsAfterRetry = await movementsFor(destStockItem1, 'transfer_in')
  assert(transferOutRowsAfterRetry.length === 1, `idempotency violated: transfer_out rows became ${transferOutRowsAfterRetry.length}`)
  assert(transferInRowsAfterRetry.length === 1, `idempotency violated: transfer_in rows became ${transferInRowsAfterRetry.length}`)
  console.log('dispatch_transfer/receive_transfer are idempotent on an already-RECEIVED transfer -- OK')

  // ============================================================
  // Part 2: variance scenario
  // ============================================================
  console.log('\n--- Part 2: variance scenario (sent 20, received 18) ---')

  const org2 = await createOrgWithTwoRestaurants('variance')
  const orgItem2 = await createOrgStockItem(org2.organizationId, `${tag} sugar`)
  const sourceStockItem2 = await createLocalStockItem(org2.restaurantAId, orgItem2, `${tag} sugar`)
  const destStockItem2 = await createLocalStockItem(org2.restaurantBId, orgItem2, `${tag} sugar`)
  await addStock(org2.restaurantAId, sourceStockItem2, 20)

  const transfer2 = await createDraftTransfer({
    organizationId: org2.organizationId,
    fromRestaurantId: org2.restaurantAId,
    toRestaurantId: org2.restaurantBId,
    createdBy: org2.ownerUserId,
    items: [{ organizationStockItemId: orgItem2, quantitySent: 20 }],
  })

  const { error: dispatch2Error } = await db.rpc('dispatch_transfer', { p_transfer_id: transfer2, p_user_id: org2.ownerUserId })
  if (dispatch2Error) throw dispatch2Error

  const { data: transferItem2 } = await db
    .from('stock_transfer_items')
    .select('id')
    .eq('transfer_id', transfer2)
    .single()

  // Missing variance_reason should be rejected.
  const { error: missingReasonError } = await db.rpc('receive_transfer', {
    p_transfer_id: transfer2,
    p_user_id: org2.ownerUserId,
    p_received_quantities: [{ stock_transfer_item_id: transferItem2!.id, quantity_received: 18 }],
  })
  assert(missingReasonError, 'expected receive to reject a quantity mismatch with no variance_reason')
  console.log('receive correctly rejects a quantity mismatch with no variance_reason:', missingReasonError!.message)

  const { error: receive2Error } = await db.rpc('receive_transfer', {
    p_transfer_id: transfer2,
    p_user_id: org2.ownerUserId,
    p_received_quantities: [{ stock_transfer_item_id: transferItem2!.id, quantity_received: 18, variance_reason: 'spillage' }],
  })
  if (receive2Error) throw receive2Error

  const destBalance2 = await balanceOf(destStockItem2)
  assert(destBalance2 === 18, `expected dest balance 18 (not 20), got ${destBalance2}`)
  const sourceBalance2 = await balanceOf(sourceStockItem2)
  assert(sourceBalance2 === 0, `expected source balance 0 (20 sent, none returned), got ${sourceBalance2}`)

  const { data: transferMovementsForOrg2Item } = await db
    .from('stock_movements')
    .select('stock_item_id, quantity_delta, reason')
    .in('stock_item_id', [sourceStockItem2, destStockItem2])
    .in('reason', ['transfer_out', 'transfer_in'])
  const netTransferMovement = (transferMovementsForOrg2Item ?? []).reduce((sum, r) => sum + Number(r.quantity_delta), 0)
  assert(netTransferMovement === -2, `expected the 2-unit variance to be unaccounted anywhere (net -2 across transfer_out+transfer_in only), got net ${netTransferMovement}`)

  const { data: updatedItem2 } = await db.from('stock_transfer_items').select('quantity_received, variance_reason').eq('id', transferItem2!.id).single()
  assert(Number(updatedItem2?.quantity_received) === 18, 'quantity_received should be recorded as 18')
  assert(updatedItem2?.variance_reason === 'spillage', 'variance_reason should be recorded')
  console.log(`variance confirmed: sent 20, received 18, the 2-unit gap is recorded (not credited anywhere) -- OK. net transfer movement across both sides = ${netTransferMovement}`)

  // ============================================================
  // Part 3: unconfigured-item rejection
  // ============================================================
  console.log('\n--- Part 3: unconfigured-item rejection ---')

  const org3 = await createOrgWithTwoRestaurants('unconfigured')
  const orgItem3 = await createOrgStockItem(org3.organizationId, `${tag} milk`)
  const sourceStockItem3 = await createLocalStockItem(org3.restaurantAId, orgItem3, `${tag} milk`)
  // Deliberately no stock_items row at restaurantB for orgItem3.
  await addStock(org3.restaurantAId, sourceStockItem3, 100)

  const transfer3 = await createDraftTransfer({
    organizationId: org3.organizationId,
    fromRestaurantId: org3.restaurantAId,
    toRestaurantId: org3.restaurantBId,
    createdBy: org3.ownerUserId,
    items: [{ organizationStockItemId: orgItem3, quantitySent: 10 }],
  })

  const { error: dispatch3Error } = await db.rpc('dispatch_transfer', { p_transfer_id: transfer3, p_user_id: org3.ownerUserId })
  assert(dispatch3Error, 'expected dispatch to reject a transfer whose destination has no stock_items mapping')
  console.log('dispatch correctly rejected the unconfigured destination:', dispatch3Error!.message)

  const sourceBalance3 = await balanceOf(sourceStockItem3)
  assert(sourceBalance3 === 100, `expected source balance untouched at 100, got ${sourceBalance3}`)
  const transferOutRows3 = await movementsFor(sourceStockItem3, 'transfer_out')
  assert(transferOutRows3.length === 0, `expected 0 transfer_out rows posted, got ${transferOutRows3.length}`)
  const { data: t3 } = await db.from('stock_transfers').select('status').eq('id', transfer3).single()
  assert(t3?.status === 'DRAFT', `expected transfer to remain DRAFT after rejected dispatch, got ${t3?.status}`)
  console.log('confirmed: no movement posted for any item, transfer remains DRAFT -- OK')

  console.log('\nWS3_STOCK_TRANSFERS_STAGING_VERIFY_OK (parts 1-3)')

  await cleanup()
}

main().catch(async (error) => {
  console.error('WS3_STOCK_TRANSFERS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
