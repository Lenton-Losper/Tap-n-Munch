/**
 * Creates a PERSISTENT test organization on staging for manual click-through testing of the
 * transfer capability via the real dashboard. Unlike every other verify-*-staging.ts script
 * in this repo, this one does NOT clean up after itself -- the fixture is meant to stay.
 *
 * Re-running this script is safe: it's idempotent by name (checks for an existing org named
 * MANUAL_TEST_ORG_NAME before creating anything new).
 *
 *   npx tsx scripts/setup-manual-test-org-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// Sourced from STAGING_TEST_PASSWORD (.env.test), not hardcoded -- same convention as every
// other staging script in this repo that creates real sign-in-able accounts.
const SHARED_PASSWORD = requireStagingTestPassword()

const MANUAL_TEST_ORG_NAME = 'Manual QA Org'
const RESTAURANT_A_NAME = 'Manual QA - Downtown'
const RESTAURANT_B_NAME = 'Manual QA - Uptown'

const OWNER_EMAIL = 'manual-qa-owner@flashtap-test.invalid'
const MANAGER_A_EMAIL = 'manual-qa-manager-downtown@flashtap-test.invalid'
const MANAGER_B_EMAIL = 'manual-qa-manager-uptown@flashtap-test.invalid'

const OWNER_PERMISSIONS = [
  'orders:read', 'orders:update', 'orders:delete', 'menu:read', 'menu:write', 'tables:read',
  'tables:manage', 'payments:process', 'payments:view', 'payments:configure', 'staff:manage',
  'settings:read', 'settings:write', 'stock:view', 'stock:receive', 'stock:adjust',
  'stock:view_costs', 'stock:delete_grv', 'stock:transfer_create', 'stock:transfer_dispatch',
  'stock:transfer_receive', 'recipe:view', 'recipe:edit', 'analytics:view', 'documents:read',
  'documents:write', 'terminal:auth:manage',
]
const MANAGER_PERMISSIONS = [
  'orders:read', 'orders:update', 'menu:read', 'menu:write', 'tables:read', 'tables:manage',
  'payments:process', 'staff:manage', 'settings:read', 'settings:write', 'stock:view',
  'stock:receive', 'stock:adjust', 'stock:transfer_create', 'stock:transfer_dispatch',
  'stock:transfer_receive', 'recipe:view', 'recipe:edit', 'analytics:view', 'documents:read',
  'documents:write', 'terminal:auth:manage',
]

async function findOrCreateAuthUser(email: string): Promise<string> {
  // Supabase admin API has no "get by email" -- page through and match, since this script
  // is meant to be safely re-runnable without creating duplicates.
  let page = 1
  while (true) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const existing = data.users.find((u) => u.email === email)
    if (existing) {
      await db.auth.admin.updateUserById(existing.id, { password: SHARED_PASSWORD })
      console.log(`  (existing) ${email}`)
      return existing.id
    }
    if (data.users.length < 200) break
    page += 1
  }

  const { data, error } = await db.auth.admin.createUser({ email, password: SHARED_PASSWORD, email_confirm: true })
  if (error || !data.user) throw error ?? new Error(`failed to create ${email}`)
  const { error: publicUserError } = await db.from('users').upsert({ id: data.user.id, email })
  if (publicUserError) throw publicUserError
  console.log(`  (created) ${email}`)
  return data.user.id
}

async function main() {
  console.log(`Setting up persistent manual-test fixture: "${MANUAL_TEST_ORG_NAME}"\n`)

  const { data: existingOrg } = await db.from('organizations').select('id').eq('name', MANUAL_TEST_ORG_NAME).maybeSingle()
  if (existingOrg) {
    console.log(`Organization "${MANUAL_TEST_ORG_NAME}" already exists (id=${existingOrg.id}).`)
    console.log('This script is idempotent by name -- delete it manually first if you want a clean rebuild.')
    console.log('Printing existing credentials below (password is reset to the current shared password each run).\n')
  }

  console.log('Auth users:')
  const ownerUserId = await findOrCreateAuthUser(OWNER_EMAIL)
  const managerAUserId = await findOrCreateAuthUser(MANAGER_A_EMAIL)
  const managerBUserId = await findOrCreateAuthUser(MANAGER_B_EMAIL)

  let organizationId: string
  if (existingOrg) {
    organizationId = existingOrg.id
  } else {
    const { data: org, error: orgError } = await db
      .from('organizations')
      .insert({ name: MANUAL_TEST_ORG_NAME, owner_user_id: ownerUserId })
      .select('id')
      .single()
    if (orgError || !org) throw orgError ?? new Error('org insert failed')
    organizationId = org.id
  }

  const { data: existingOrgUser } = await db
    .from('organization_users')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('user_id', ownerUserId)
    .maybeSingle()
  if (!existingOrgUser) {
    const { error } = await db.from('organization_users').insert({ organization_id: organizationId, user_id: ownerUserId, role: 'OWNER' })
    if (error) throw error
  }

  async function findOrCreateRestaurant(name: string): Promise<string> {
    const { data: existing } = await db.from('restaurants').select('id').eq('name', name).eq('organization_id', organizationId).maybeSingle()
    if (existing) return existing.id
    const { data, error } = await db.from('restaurants').insert({ name, organization_id: organizationId }).select('id').single()
    if (error || !data) throw error ?? new Error(`restaurant insert failed for ${name}`)
    return data.id
  }

  const restaurantAId = await findOrCreateRestaurant(RESTAURANT_A_NAME)
  const restaurantBId = await findOrCreateRestaurant(RESTAURANT_B_NAME)

  async function ensureRole(restaurantId: string, roleSlug: string, displayName: string, permissions: string[], isSystem: boolean) {
    const { error } = await db
      .from('restaurant_roles')
      .upsert(
        { restaurant_id: restaurantId, role_slug: roleSlug, display_name: displayName, permissions, is_system: isSystem },
        { onConflict: 'restaurant_id,role_slug' },
      )
    if (error) throw error
  }

  async function ensureMembership(restaurantId: string, userId: string, role: string) {
    const { data: existing } = await db.from('restaurant_users').select('id').eq('restaurant_id', restaurantId).eq('user_id', userId).maybeSingle()
    if (existing) return
    const { error } = await db.from('restaurant_users').insert({ restaurant_id: restaurantId, user_id: userId, role })
    if (error) throw error
  }

  // Owner: full role at their home restaurant (Downtown) so /stock loads for them directly;
  // org-wide visibility (switcher + aggregate view) comes from the OWNER organization_users
  // row above, not from restaurant membership.
  await ensureRole(restaurantAId, 'owner', 'Owner', OWNER_PERMISSIONS, true)
  await ensureMembership(restaurantAId, ownerUserId, 'owner')

  await ensureRole(restaurantAId, 'manager', 'Manager', MANAGER_PERMISSIONS, false)
  await ensureMembership(restaurantAId, managerAUserId, 'manager')

  await ensureRole(restaurantBId, 'manager', 'Manager', MANAGER_PERMISSIONS, false)
  await ensureMembership(restaurantBId, managerBUserId, 'manager')

  // Canonical item, configured at both locations, with starting stock at the source.
  const ITEM_NAME = 'Flour'
  const { data: kgUnit, error: kgUnitError } = await db.from('measurement_units').select('id').is('restaurant_id', null).eq('name', 'kg').single()
  if (kgUnitError || !kgUnit) throw kgUnitError ?? new Error('system unit "kg" missing')
  const kgUnitId: string = kgUnit.id

  let orgStockItemId: string
  const { data: existingOrgItem } = await db
    .from('organization_stock_items')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('name', ITEM_NAME)
    .maybeSingle()
  if (existingOrgItem) {
    orgStockItemId = existingOrgItem.id
  } else {
    const { data, error } = await db
      .from('organization_stock_items')
      .insert({ organization_id: organizationId, name: ITEM_NAME, base_unit_id: kgUnitId })
      .select('id')
      .single()
    if (error || !data) throw error ?? new Error('org stock item insert failed')
    orgStockItemId = data.id
  }

  async function ensureLocalStockItem(restaurantId: string): Promise<string> {
    const { data: existing } = await db
      .from('stock_items')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('organization_stock_item_id', orgStockItemId)
      .eq('is_active', true)
      .maybeSingle()
    if (existing) return existing.id
    const { data, error } = await db
      .from('stock_items')
      .insert({ restaurant_id: restaurantId, organization_stock_item_id: orgStockItemId, name: ITEM_NAME, unit_id: kgUnitId, is_active: true })
      .select('id')
      .single()
    if (error || !data) throw error ?? new Error('local stock item insert failed')
    return data.id
  }

  const stockItemAId = await ensureLocalStockItem(restaurantAId)
  await ensureLocalStockItem(restaurantBId)

  const { data: existingBalance } = await db.from('stock_movements').select('quantity_delta').eq('stock_item_id', stockItemAId)
  const currentBalance = (existingBalance ?? []).reduce((sum, r) => sum + Number(r.quantity_delta), 0)
  const STARTING_STOCK = 50
  if (currentBalance < STARTING_STOCK) {
    const { error } = await db.from('stock_movements').insert({
      restaurant_id: restaurantAId,
      stock_item_id: stockItemAId,
      quantity_delta: STARTING_STOCK - currentBalance,
      reason: 'received',
    })
    if (error) throw error
  }

  console.log('\n' + '='.repeat(72))
  console.log('PERSISTENT MANUAL-TEST FIXTURE READY (not cleaned up -- stays until you delete it)')
  console.log('='.repeat(72))
  console.log(`
Organization: ${MANUAL_TEST_ORG_NAME}  (id: ${organizationId})

Restaurants:
  Source (Downtown):      ${RESTAURANT_A_NAME}  (id: ${restaurantAId})
  Destination (Uptown):   ${RESTAURANT_B_NAME}  (id: ${restaurantBId})

Canonical item: "${ITEM_NAME}" -- configured at both locations, ${STARTING_STOCK} kg starting stock at ${RESTAURANT_A_NAME}.

Login credentials (staging dashboard sign-in, shared password for all three):
  Password (all accounts): ${SHARED_PASSWORD}

  Organization OWNER (sees the location switcher + "All locations" aggregate view):
    Email: ${OWNER_EMAIL}
    Home restaurant on login: ${RESTAURANT_A_NAME}

  Manager at ${RESTAURANT_A_NAME} (source -- can create/dispatch/cancel transfers):
    Email: ${MANAGER_A_EMAIL}

  Manager at ${RESTAURANT_B_NAME} (destination -- can receive transfers):
    Email: ${MANAGER_B_EMAIL}

Try it: sign in as the Downtown manager -> Stock -> Transfers -> Create Transfer -> send
some Flour to ${RESTAURANT_B_NAME} -> Dispatch. Then sign in as the Uptown manager -> Stock
-> Transfers -> Incoming -> Confirm all received (or Report difference).
`)
}

main().catch((error) => {
  console.error('SETUP_MANUAL_TEST_ORG_FAIL', error)
  process.exit(1)
})
