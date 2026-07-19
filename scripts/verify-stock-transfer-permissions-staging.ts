/**
 * Staging verification for Workstream 4 (permissions + RLS):
 *  - a source-location manager can create + dispatch from their own restaurant
 *  - that same manager cannot dispatch a transfer from a restaurant they don't belong to
 *  - a destination-location manager can receive; cannot receive a transfer not addressed
 *    to their restaurant
 *  - an organization OWNER can read every transfer in their org via RLS alone (no
 *    restaurant_users row needed); a MEMBER cannot (unless they separately hold
 *    restaurant-level access)
 *  - a user with zero relationship to either restaurant cannot read the transfer at all --
 *    RLS blocks it, not just a hidden UI button
 *   npx tsx scripts/verify-stock-transfer-permissions-staging.ts
 *
 * The existing authorize() regression suite (__tests__/authorize-restaurant-roles.test.ts,
 * __tests__/authorize-staff-permissions.test.ts) is run separately -- see the PR notes.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!
if (!stagingUrl?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase (.env.test)')

// lib/supabase/server.ts (createServerSupabaseClient, used by lib/permissions/authorize.ts
// and lib/stock/transfers.ts) reads NEXT_PUBLIC_SUPABASE_URL, not SUPABASE_URL.
process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `ws4-${Date.now()}`
let unitGId = ''

const created = {
  userIds: [] as string[],
  organizationIds: [] as string[],
  restaurantIds: [] as string[],
  orgStockItemIds: [] as string[],
  stockItemIds: [] as string[],
  transferIds: [] as string[],
}
const userPasswords = new Map<string, string>()
const userEmails = new Map<string, string>()

async function cleanup() {
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
    await db.from('restaurant_roles').delete().in('restaurant_id', created.restaurantIds)
    await db.from('restaurant_users').delete().in('restaurant_id', created.restaurantIds)
    await db.from('restaurants').delete().in('id', created.restaurantIds)
  }
  if (created.organizationIds.length) {
    await db.from('organization_users').delete().in('organization_id', created.organizationIds)
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

async function createRealAuthUser(emailTag: string): Promise<string> {
  const email = `${tag}-${emailTag}@flashtap-test.invalid`
  const password = `P${randomUUID()}!1`
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  created.userIds.push(userId)
  userPasswords.set(userId, password)
  userEmails.set(userId, email)
  const { error: publicUserError } = await db.from('users').insert({ id: userId, email })
  if (publicUserError) throw publicUserError
  return userId
}

async function signInAs(userId: string) {
  const email = userEmails.get(userId)!
  const password = userPasswords.get(userId)!
  const client = createClient(stagingUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
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

  const { error: orgOwnerMembershipError } = await db
    .from('organization_users')
    .insert({ organization_id: org.id, user_id: ownerUserId, role: 'OWNER' })
  if (orgOwnerMembershipError) throw orgOwnerMembershipError

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

const TRANSFER_PERMISSIONS = ['stock:transfer_create', 'stock:transfer_dispatch', 'stock:transfer_receive', 'stock:view']

async function createManagerAt(restaurantId: string, tagSuffix: string): Promise<string> {
  const { error: roleError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restaurantId, role_slug: 'manager', display_name: 'Manager', permissions: TRANSFER_PERMISSIONS, is_system: false })
  if (roleError) throw roleError

  const userId = await createRealAuthUser(`manager-${tagSuffix}`)
  const { error: membershipError } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restaurantId, user_id: userId, role: 'manager' })
  if (membershipError) throw membershipError

  return userId
}

async function createOrgMember(organizationId: string, tagSuffix: string): Promise<string> {
  const userId = await createRealAuthUser(`member-${tagSuffix}`)
  const { error } = await db.from('organization_users').insert({ organization_id: organizationId, user_id: userId, role: 'MEMBER' })
  if (error) throw error
  return userId
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
    .insert({ restaurant_id: restaurantId, organization_stock_item_id: orgStockItemId, name, unit_id: unitGId, is_active: true })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('local stock item insert failed')
  created.stockItemIds.push(data.id)
  return data.id
}

async function addStock(restaurantId: string, stockItemId: string, quantity: number) {
  const { error } = await db.from('stock_movements').insert({ restaurant_id: restaurantId, stock_item_id: stockItemId, quantity_delta: quantity, reason: 'received' })
  if (error) throw error
}

async function main() {
  const { data: gUnit, error: gUnitError } = await db.from('measurement_units').select('id').is('restaurant_id', null).eq('name', 'g').single()
  if (gUnitError || !gUnit) throw gUnitError ?? new Error('system unit "g" missing')
  unitGId = gUnit.id

  const { createTransfer, dispatchTransfer, receiveTransfer } = await import('../lib/stock/transfers')

  const org = await createOrgWithTwoRestaurants('perm')
  const orgItem = await createOrgStockItem(org.organizationId, `${tag} beans`)
  const sourceStockItem = await createLocalStockItem(org.restaurantAId, orgItem, `${tag} beans`)
  await createLocalStockItem(org.restaurantBId, orgItem, `${tag} beans`)
  await addStock(org.restaurantAId, sourceStockItem, 50)

  const managerA = await createManagerAt(org.restaurantAId, 'A')
  const managerB = await createManagerAt(org.restaurantBId, 'B')
  const orgMember = await createOrgMember(org.organizationId, 'perm')

  // A fully unrelated org/restaurant pair, to get an unrelated real user (no relationship
  // whatsoever to org.organizationId, restaurantAId, or restaurantBId).
  const unrelatedOrg = await createOrgWithTwoRestaurants('unrelated')

  // ============================================================
  // Part 1: create + dispatch as the source-location manager
  // ============================================================
  console.log('--- Part 1: source-location manager can create + dispatch ---')

  const createResult = await createTransfer({
    userId: managerA,
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    items: [{ organizationStockItemId: orgItem, quantitySent: 10, unitId: unitGId }],
  })
  assert('data' in createResult, `expected managerA to create a transfer, got: ${JSON.stringify(createResult)}`)
  const transferId = createResult.data.transferId
  created.transferIds.push(transferId)
  console.log('managerA (source restaurant) created a DRAFT transfer -- OK', transferId)

  const dispatchAsManagerA = await dispatchTransfer(managerA, transferId)
  assert('data' in dispatchAsManagerA, `expected managerA to dispatch, got: ${JSON.stringify(dispatchAsManagerA)}`)
  console.log('managerA (source restaurant) dispatched the transfer -- OK')

  // ============================================================
  // Part 2: cannot create/dispatch from a restaurant you don't belong to
  // ============================================================
  console.log('\n--- Part 2: cannot create/dispatch from a restaurant you do not belong to ---')

  const createByManagerBAtA = await createTransfer({
    userId: managerB,
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    items: [{ organizationStockItemId: orgItem, quantitySent: 5, unitId: unitGId }],
  })
  assert('error' in createByManagerBAtA, 'expected managerB (belongs only to restaurant B) to be rejected creating a transfer FROM restaurant A')
  console.log('managerB correctly rejected creating a transfer from restaurant A:', createByManagerBAtA.error)

  const secondTransferForDispatchTest = await createTransfer({
    userId: managerA,
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    items: [{ organizationStockItemId: orgItem, quantitySent: 5, unitId: unitGId }],
  })
  assert('data' in secondTransferForDispatchTest, 'setup: managerA should be able to create a second transfer')
  created.transferIds.push(secondTransferForDispatchTest.data.transferId)

  const dispatchByManagerB = await dispatchTransfer(managerB, secondTransferForDispatchTest.data.transferId)
  assert('error' in dispatchByManagerB, 'expected managerB (does not belong to restaurant A) to be rejected dispatching restaurant A -> B')
  console.log('managerB correctly rejected dispatching a transfer FROM restaurant A (not their restaurant):', dispatchByManagerB.error)

  const { data: stillDraft } = await db.from('stock_transfers').select('status').eq('id', secondTransferForDispatchTest.data.transferId).single()
  assert(stillDraft?.status === 'DRAFT', `transfer should remain DRAFT after a rejected dispatch attempt, got ${stillDraft?.status}`)
  console.log('confirmed: rejected dispatch attempt left the transfer untouched (still DRAFT) -- OK')

  // ============================================================
  // Part 3: destination-location manager can receive; cannot receive elsewhere
  // ============================================================
  console.log('\n--- Part 3: destination-location manager can receive; cannot receive elsewhere ---')

  const receiveByManagerA = await receiveTransfer(managerA, transferId)
  assert('error' in receiveByManagerA, 'expected managerA (does not belong to restaurant B, the destination) to be rejected receiving')
  console.log('managerA correctly rejected receiving at restaurant B (not their restaurant):', receiveByManagerA.error)

  const receiveByManagerB = await receiveTransfer(managerB, transferId)
  assert('data' in receiveByManagerB, `expected managerB (destination restaurant) to receive successfully, got: ${JSON.stringify(receiveByManagerB)}`)
  console.log('managerB (destination restaurant) received the transfer -- OK')

  const { data: receivedTransfer } = await db.from('stock_transfers').select('status').eq('id', transferId).single()
  assert(receivedTransfer?.status === 'RECEIVED', `expected RECEIVED, got ${receivedTransfer?.status}`)

  // ============================================================
  // Part 4: RLS -- org OWNER sees everything, MEMBER doesn't, unrelated user sees nothing
  // ============================================================
  console.log('\n--- Part 4: RLS read access (org OWNER / MEMBER / unrelated user) ---')

  const ownerClient = await signInAs(org.ownerUserId)
  const { data: ownerVisibleTransfer, error: ownerReadError } = await ownerClient
    .from('stock_transfers')
    .select('id, from_restaurant_id, to_restaurant_id')
    .eq('id', transferId)
    .maybeSingle()
  if (ownerReadError) throw ownerReadError
  assert(ownerVisibleTransfer?.id === transferId, 'org OWNER should be able to read a transfer in their org via organization_users alone (no restaurant_users row)')
  console.log('org OWNER (no restaurant_users row at either location) can read the transfer via RLS -- OK')

  const { data: ownerVisibleAll, error: ownerAllError } = await ownerClient
    .from('stock_transfers')
    .select('id')
    .in('id', created.transferIds)
  if (ownerAllError) throw ownerAllError
  assert(ownerVisibleAll?.length === created.transferIds.length, `org OWNER should see all ${created.transferIds.length} transfers in their org, saw ${ownerVisibleAll?.length}`)
  console.log(`org OWNER sees all ${ownerVisibleAll?.length} transfers across every location in their org -- OK`)
  await ownerClient.auth.signOut()

  const memberClient = await signInAs(orgMember)
  const { data: memberVisibleTransfer, error: memberReadError } = await memberClient
    .from('stock_transfers')
    .select('id')
    .eq('id', transferId)
    .maybeSingle()
  if (memberReadError) throw memberReadError
  assert(!memberVisibleTransfer, `org MEMBER should NOT be able to read a transfer via organization_users alone, but saw: ${JSON.stringify(memberVisibleTransfer)}`)
  console.log('org MEMBER (no restaurant-level access) correctly cannot read the transfer -- RLS blocks it -- OK')
  await memberClient.auth.signOut()

  const unrelatedClient = await signInAs(unrelatedOrg.ownerUserId)
  const { data: unrelatedVisibleTransfer, error: unrelatedReadError } = await unrelatedClient
    .from('stock_transfers')
    .select('id')
    .eq('id', transferId)
    .maybeSingle()
  if (unrelatedReadError) throw unrelatedReadError
  assert(!unrelatedVisibleTransfer, `a user with zero relationship to either restaurant should NOT be able to read the transfer, but saw: ${JSON.stringify(unrelatedVisibleTransfer)}`)
  console.log('user with zero relationship to either restaurant/org correctly cannot read the transfer at all -- RLS blocks it, not just the UI -- OK')
  await unrelatedClient.auth.signOut()

  // ============================================================
  // Part 5: authorizeOrganization fallback -- org OWNER with NO restaurant-level access
  // ============================================================
  console.log('\n--- Part 5: authorizeOrganization create_cross_location_transfer fallback ---')

  const { authorizeOrganization } = await import('../lib/permissions/authorize')
  const ownerCanCreateForOrg = await authorizeOrganization(org.ownerUserId, org.organizationId, 'create_cross_location_transfer')
  assert(ownerCanCreateForOrg, 'org OWNER should authorize create_cross_location_transfer for their own organization')
  const memberCanCreateForOrg = await authorizeOrganization(orgMember, org.organizationId, 'create_cross_location_transfer')
  assert(!memberCanCreateForOrg, 'org MEMBER should NOT authorize create_cross_location_transfer in v1')
  console.log('authorizeOrganization: OWNER -> true, MEMBER -> false -- OK')

  // org.ownerUserId has zero restaurant_users rows anywhere -- this only succeeds via the
  // authorizeOrganization fallback inside createTransfer, not via authorize() at all.
  const createByOrgOwner = await createTransfer({
    userId: org.ownerUserId,
    organizationId: org.organizationId,
    fromRestaurantId: org.restaurantAId,
    toRestaurantId: org.restaurantBId,
    items: [{ organizationStockItemId: orgItem, quantitySent: 1, unitId: unitGId }],
  })
  assert('data' in createByOrgOwner, `expected org OWNER (no restaurant_users row) to create a transfer via the org-level fallback, got: ${JSON.stringify(createByOrgOwner)}`)
  created.transferIds.push(createByOrgOwner.data.transferId)
  console.log('org OWNER with zero restaurant-level access created a transfer via the authorizeOrganization fallback -- OK')

  console.log('\nWS4_STOCK_TRANSFER_PERMISSIONS_STAGING_VERIFY_OK')

  await cleanup()
}

main().catch(async (error) => {
  console.error('WS4_STOCK_TRANSFER_PERMISSIONS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
