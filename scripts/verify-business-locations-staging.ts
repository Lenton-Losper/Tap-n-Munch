/**
 * Staging verification for Business & Locations (Settings UI + Add Location flow), driven
 * through the real deployed app with Playwright where the task specifically calls for it:
 *  - a brand-new signup creates an organization + first location, with an editable
 *    Business Name field that pre-fills from (and can diverge from) the location name
 *  - the resulting owner adds a second location via the Settings > Business > Add Location
 *    wizard, "start empty" -- verified to have zero stock_items
 *  - the same owner adds a third location via the "copy configuration from an existing
 *    location" path -- verified to match the source's stock_items config exactly
 *    (organization_stock_item_id, unit, purchase_unit, conversion_factor, par_level) while
 *    starting with zero stock_movements/quantity regardless of the source's quantity
 *  - a non-owner manager at the first location cannot see "Add Location" in Settings, and
 *    authorizeOrganization independently denies them 'create_location'
 *  - the copy-configured third location works immediately as a real transfer source to the
 *    first location (create -> dispatch -> receive), proving it's a fully working location
 *    and not just a config-only shell
 *
 *   npx tsx scripts/verify-business-locations-staging.ts
 */
import { chromium, type Browser, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const STAGING_TEST_PASSWORD = requireStagingTestPassword()
const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')
const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT || ''

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `bizloc-${Date.now()}`

const created = {
  userIds: [] as string[],
  organizationIds: [] as string[],
  restaurantIds: [] as string[],
  orgStockItemIds: [] as string[],
  stockItemIds: [] as string[],
  transferIds: [] as string[],
}
const userEmails = new Map<string, string>()

async function cleanup() {
  if (process.env.PW_SKIP_CLEANUP) {
    console.log('PW_SKIP_CLEANUP set -- leaving fixtures in place for inspection:', JSON.stringify(created))
    return
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
    await db.from('restaurant_setup_status').delete().in('restaurant_id', created.restaurantIds)
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

async function createRealAuthUser(emailTag: string): Promise<{ userId: string; email: string }> {
  const email = `${tag}-${emailTag}@flashtap-test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, password: STAGING_TEST_PASSWORD, email_confirm: true })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  created.userIds.push(userId)
  userEmails.set(userId, email)
  const { error: publicUserError } = await db.from('users').insert({ id: userId, email })
  if (publicUserError) throw publicUserError
  return { userId, email }
}

async function waitForDeploy() {
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/version`)
      const body = (await res.json().catch(() => ({}))) as { commit?: string }
      const commit = String(body.commit || '')
      if (EXPECTED_COMMIT && !commit.startsWith(EXPECTED_COMMIT.slice(0, 7))) {
        throw new Error(`Expected commit ${EXPECTED_COMMIT}, got ${commit || '(missing)'}`)
      }
      console.log('Deployed commit:', commit || '(unknown)')
      return commit
    } catch (err) {
      lastErr = err
      console.log(`waitForDeploy attempt ${attempt} failed (transient network?), retrying...`, String(err))
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

async function loginAs(browser: Browser, userId: string): Promise<Page> {
  const email = userEmails.get(userId)!
  const page = await browser.newPage()
  await page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(STAGING_TEST_PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(/dashboard|menu-management|onboarding/, { timeout: 60000 })
  return page
}

async function main() {
  await waitForDeploy()
  const browser = await chromium.launch()

  try {
    // ============================================================
    // Part 1: brand-new signup creates org + first location, with editable prefilled
    // business name (real UI, real /api/auth/signup)
    // ============================================================
    console.log('\n--- Part 1: signup UI creates business + first location ---')
    const ownerEmail = `${tag}-owner@flashtap-test.invalid`
    const locationName = `${tag} Mingle`

    const signupPage = await browser.newPage()
    await signupPage.goto(`${BASE_URL}/signup`, { waitUntil: 'domcontentloaded' })
    await signupPage.locator('#fullName').fill('Biz Owner')
    await signupPage.locator('#email').fill(ownerEmail)
    await signupPage.locator('#password').fill(STAGING_TEST_PASSWORD)
    await signupPage.locator('#confirmPassword').fill(STAGING_TEST_PASSWORD)
    await signupPage.locator('#restaurantName').fill(locationName)

    // Business Name must auto-follow the location name until manually edited.
    const businessNameValueAfterLocationFill = await signupPage.locator('#businessName').inputValue()
    assert(
      businessNameValueAfterLocationFill === locationName,
      `expected Business Name to auto-prefill to "${locationName}", got "${businessNameValueAfterLocationFill}"`,
    )
    console.log('Business Name auto-prefilled from location name -- OK')

    const businessName = `${tag} Group Holdings`
    await signupPage.locator('#businessName').fill('')
    await signupPage.locator('#businessName').fill(businessName)

    // Further edits to the location name must NOT overwrite the now-manually-edited business
    // name -- proves the two fields genuinely diverge, not just "prefill once at mount".
    await signupPage.locator('#restaurantName').fill(`${locationName} Renamed`)
    const businessNameAfterDivergence = await signupPage.locator('#businessName').inputValue()
    assert(
      businessNameAfterDivergence === businessName,
      `expected Business Name to stay "${businessName}" after manual edit, got "${businessNameAfterDivergence}"`,
    )
    await signupPage.locator('#restaurantName').fill(locationName)
    console.log('Business Name stops auto-following after manual edit -- OK')

    await signupPage.getByRole('button', { name: /create account/i }).click()
    await signupPage.waitForURL(/onboarding|dashboard/, { timeout: 30000 })
    console.log('Signup submitted via UI, redirected past account creation -- OK')

    const { data: authUser } = await db.auth.admin.listUsers()
    const ownerUser = authUser.users.find((u) => u.email === ownerEmail)
    assert(ownerUser, 'expected the signed-up user to exist in auth')
    const ownerUserId = ownerUser!.id
    created.userIds.push(ownerUserId)
    userEmails.set(ownerUserId, ownerEmail)

    const { data: restaurant1 } = await db
      .from('restaurants')
      .select('id, name, organization_id')
      .eq('name', locationName)
      .maybeSingle()
    assert(restaurant1, 'expected the first location (restaurant) to have been created')
    created.restaurantIds.push(restaurant1!.id)
    const organizationId = restaurant1!.organization_id as string
    created.organizationIds.push(organizationId)

    const { data: org } = await db.from('organizations').select('name').eq('id', organizationId).single()
    assert(org?.name === businessName, `expected organization name "${businessName}", got "${org?.name}"`)
    console.log('Organization created with the edited business name -- OK')

    const { data: ownerOrgMembership } = await db
      .from('organization_users')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', ownerUserId)
      .maybeSingle()
    assert(ownerOrgMembership?.role === 'OWNER', 'expected the signed-up user to be organization OWNER')
    console.log('Signed-up user is the organization OWNER -- OK')

    // ============================================================
    // Fixture setup: configure real stock at location 1 (par_level/purchase_unit/
    // conversion_factor + an actual quantity), used to prove the "copy configuration"
    // path copies config but never quantity.
    // ============================================================
    const { data: gUnit } = await db.from('measurement_units').select('id').is('restaurant_id', null).eq('name', 'g').single()
    assert(gUnit, 'system unit "g" missing')

    const { data: orgItem, error: orgItemError } = await db
      .from('organization_stock_items')
      .insert({ organization_id: organizationId, name: `${tag} Flour`, base_unit_id: gUnit!.id })
      .select('id')
      .single()
    if (orgItemError || !orgItem) throw orgItemError ?? new Error('org stock item insert failed')
    created.orgStockItemIds.push(orgItem.id)

    const { data: stockItem1, error: stockItem1Error } = await db
      .from('stock_items')
      .insert({
        restaurant_id: restaurant1!.id,
        organization_stock_item_id: orgItem.id,
        name: `${tag} Flour`,
        unit_id: gUnit!.id,
        is_active: true,
        is_purchasable: true,
        is_manufactured: false,
        purchase_unit: '25kg bag',
        conversion_factor: 25000,
        par_level: 50000,
      })
      .select('id')
      .single()
    if (stockItem1Error || !stockItem1) throw stockItem1Error ?? new Error('stock item 1 insert failed')
    created.stockItemIds.push(stockItem1.id)

    const { error: movementError } = await db
      .from('stock_movements')
      .insert({ restaurant_id: restaurant1!.id, stock_item_id: stockItem1.id, quantity_delta: 12000, reason: 'received' })
    if (movementError) throw movementError
    console.log('Fixture: location 1 has a configured stock item with real quantity -- OK')

    // ============================================================
    // Part 2: owner adds a second location via the Settings > Business > Add Location
    // wizard, "start empty"
    // ============================================================
    console.log('\n--- Part 2: Add Location wizard -- start empty (real UI) ---')
    const ownerPage = await loginAs(browser, ownerUserId)
    await ownerPage.goto(`${BASE_URL}/settings#business`, { waitUntil: 'domcontentloaded' })
    await ownerPage.getByRole('heading', { name: /^locations$/i }).waitFor({ timeout: 30000 })
    await ownerPage.getByText(locationName).first().waitFor({ timeout: 15000 })

    const location2Name = `${tag} Riverside`
    await ownerPage.getByRole('button', { name: /add location/i }).click()
    await ownerPage.getByRole('dialog').waitFor({ timeout: 10000 })
    await ownerPage.locator('#location-name').fill(location2Name)
    await ownerPage.locator('#location-address').fill('12 Empty Start Rd')
    // "Start empty" is already the default selection; submit directly.
    await ownerPage.getByRole('button', { name: /^add location$/i }).last().click()
    await ownerPage.getByText(location2Name).first().waitFor({ timeout: 15000 })
    console.log('Second location ("start empty") created and visible in the list -- OK')

    const { data: restaurant2 } = await db
      .from('restaurants')
      .select('id, organization_id')
      .eq('name', location2Name)
      .maybeSingle()
    assert(restaurant2, 'expected the second location to exist in the database')
    assert(restaurant2!.organization_id === organizationId, 'expected the second location to belong to the same organization')
    created.restaurantIds.push(restaurant2!.id)

    const { data: restaurant2Membership } = await db
      .from('restaurant_users')
      .select('role')
      .eq('restaurant_id', restaurant2!.id)
      .eq('user_id', ownerUserId)
      .maybeSingle()
    assert(restaurant2Membership?.role === 'owner', 'expected the org owner to be seeded as owner at the second location')

    const { data: restaurant2StockItems } = await db.from('stock_items').select('id').eq('restaurant_id', restaurant2!.id)
    assert((restaurant2StockItems?.length ?? 0) === 0, `expected zero stock_items for the "start empty" location, got ${restaurant2StockItems?.length}`)
    console.log('"Start empty" location has zero stock_items, correctly scoped to the org, owner seeded -- OK')

    // ============================================================
    // Part 3: owner adds a third location, copying stock configuration from location 1
    // ============================================================
    console.log('\n--- Part 3: Add Location wizard -- copy from existing location (real UI) ---')
    const location3Name = `${tag} Uptown`
    await ownerPage.goto(`${BASE_URL}/settings#business`, { waitUntil: 'domcontentloaded' })
    await ownerPage.getByRole('button', { name: /add location/i }).click()
    await ownerPage.getByRole('dialog').waitFor({ timeout: 10000 })
    await ownerPage.locator('#location-name').fill(location3Name)
    await ownerPage.locator('#setup-copy').click()
    await ownerPage.locator('button[role="combobox"]').click()
    await ownerPage.getByRole('option', { name: locationName }).click()
    await ownerPage.getByRole('button', { name: /^add location$/i }).last().click()
    await ownerPage.getByText(location3Name).first().waitFor({ timeout: 15000 })
    console.log('Third location ("copy configuration") created and visible in the list -- OK')

    const { data: restaurant3 } = await db.from('restaurants').select('id').eq('name', location3Name).maybeSingle()
    assert(restaurant3, 'expected the third location to exist in the database')
    created.restaurantIds.push(restaurant3!.id)

    const { data: restaurant3StockItems } = await db
      .from('stock_items')
      .select('id, organization_stock_item_id, name, unit_id, is_purchasable, is_manufactured, is_active, purchase_unit, conversion_factor, par_level')
      .eq('restaurant_id', restaurant3!.id)
    assert(restaurant3StockItems?.length === 1, `expected exactly 1 copied stock item, got ${restaurant3StockItems?.length}`)
    const copiedItem = restaurant3StockItems![0]
    created.stockItemIds.push(copiedItem.id)
    assert(copiedItem.organization_stock_item_id === orgItem.id, 'expected copied item to link the same canonical organization_stock_item')
    assert(copiedItem.unit_id === gUnit!.id, 'expected copied item unit to match source')
    assert(copiedItem.purchase_unit === '25kg bag', `expected purchase_unit "25kg bag", got "${copiedItem.purchase_unit}"`)
    assert(Number(copiedItem.conversion_factor) === 25000, `expected conversion_factor 25000, got ${copiedItem.conversion_factor}`)
    assert(Number(copiedItem.par_level) === 50000, `expected par_level 50000, got ${copiedItem.par_level}`)
    assert(copiedItem.is_active === true, 'expected copied item to be active')
    console.log('Copied stock item exactly matches source config (unit, purchase_unit, conversion_factor, par_level) -- OK')

    const { data: restaurant3Movements } = await db.from('stock_movements').select('id').eq('stock_item_id', copiedItem.id)
    assert((restaurant3Movements?.length ?? 0) === 0, `expected ZERO stock_movements for the copy-configured location, got ${restaurant3Movements?.length}`)
    console.log('Copy-configured location starts with zero stock_movements despite source having quantity -- OK')

    // ============================================================
    // Part 4: non-owner manager cannot see/use Add Location
    // ============================================================
    console.log('\n--- Part 4: non-owner manager blocked from Add Location ---')
    // restaurant1 already has a 'manager' role seeded by create_restaurant_for_user's default
    // role seed (buildDefaultRestaurantRolesSeed) -- reuse it rather than inserting a second
    // one, which would collide with restaurant_roles' (restaurant_id, role_slug) uniqueness.
    const { userId: managerUserId } = await createRealAuthUser('manager')
    const { error: managerMembershipError } = await db
      .from('restaurant_users')
      .insert({ restaurant_id: restaurant1!.id, user_id: managerUserId, role: 'manager' })
    if (managerMembershipError) throw managerMembershipError

    const { authorizeOrganization } = await import('../lib/permissions/authorize')
    const managerCanCreateLocation = await authorizeOrganization(managerUserId, organizationId, 'create_location')
    assert(managerCanCreateLocation === false, 'expected authorizeOrganization to deny create_location for a non-owner manager')
    console.log('authorizeOrganization directly denies non-owner manager -- OK')

    const managerPage = await loginAs(browser, managerUserId)
    await managerPage.goto(`${BASE_URL}/settings#business`, { waitUntil: 'domcontentloaded' })
    await managerPage.getByRole('heading', { name: /^locations$/i }).waitFor({ timeout: 30000 })
    const addLocationButtonCount = await managerPage.getByRole('button', { name: /add location/i }).count()
    assert(addLocationButtonCount === 0, `expected NO "Add Location" button for a non-owner manager, found ${addLocationButtonCount}`)
    console.log('Non-owner manager sees no "Add Location" button in Settings -- OK')
    await managerPage.close()

    // Defense-in-depth: the RPC itself is service_role-only, so even a directly authenticated
    // (non-service) client cannot call it and bypass the TypeScript authorization check.
    if (ANON_KEY) {
      const managerAuthClient = createClient(SUPABASE_URL, ANON_KEY)
      const { error: signInError } = await managerAuthClient.auth.signInWithPassword({
        email: userEmails.get(managerUserId)!,
        password: STAGING_TEST_PASSWORD,
      })
      if (signInError) throw signInError
      const { error: directRpcError } = await managerAuthClient.rpc('create_organization_location', {
        p_organization_id: organizationId,
        p_created_by_user_id: managerUserId,
        p_name: 'Should Not Exist',
        p_address: null,
        p_roles: [],
      })
      assert(directRpcError, 'expected create_organization_location to reject a direct authenticated-client call (service_role-only)')
      console.log('create_organization_location RPC rejects direct authenticated-client calls -- OK')
    }

    // ============================================================
    // Part 5: the copy-configured third location works immediately as a real transfer
    // source to location 1
    // ============================================================
    console.log('\n--- Part 5: new location works as a real transfer source ---')
    const { error: r3MovementError } = await db
      .from('stock_movements')
      .insert({ restaurant_id: restaurant3!.id, stock_item_id: copiedItem.id, quantity_delta: 8000, reason: 'received' })
    if (r3MovementError) throw r3MovementError

    const { createTransfer, dispatchTransfer, receiveTransfer } = await import('../lib/stock/transfers')
    const created3to1 = await createTransfer({
      userId: ownerUserId,
      organizationId,
      fromRestaurantId: restaurant3!.id,
      toRestaurantId: restaurant1!.id,
      items: [{ organizationStockItemId: orgItem.id, quantitySent: 3000, unitId: gUnit!.id }],
    })
    assert('data' in created3to1, `expected transfer creation from the new location to succeed, got ${JSON.stringify(created3to1)}`)
    created.transferIds.push(created3to1.data.transferId)

    const dispatched = await dispatchTransfer(ownerUserId, created3to1.data.transferId)
    assert('data' in dispatched, `expected dispatch from the new location to succeed, got ${JSON.stringify(dispatched)}`)

    const { data: afterDispatch } = await db.from('stock_transfers').select('status').eq('id', created3to1.data.transferId).single()
    assert(afterDispatch?.status === 'IN_TRANSIT', `expected IN_TRANSIT, got ${afterDispatch?.status}`)

    const received = await receiveTransfer(ownerUserId, created3to1.data.transferId)
    assert('data' in received, `expected receive at location 1 to succeed, got ${JSON.stringify(received)}`)

    const { data: afterReceive } = await db.from('stock_transfers').select('status').eq('id', created3to1.data.transferId).single()
    assert(afterReceive?.status === 'RECEIVED', `expected RECEIVED, got ${afterReceive?.status}`)

    const { data: r3MovementsAfter } = await db
      .from('stock_movements')
      .select('quantity_delta')
      .eq('restaurant_id', restaurant3!.id)
      .eq('stock_item_id', copiedItem.id)
    const r3Balance = (r3MovementsAfter ?? []).reduce((sum, m) => sum + Number(m.quantity_delta), 0)
    assert(r3Balance === 5000, `expected location 3 balance 8000 - 3000 = 5000 after dispatch, got ${r3Balance}`)

    const { data: r1MovementsAfter } = await db
      .from('stock_movements')
      .select('quantity_delta')
      .eq('restaurant_id', restaurant1!.id)
      .eq('stock_item_id', stockItem1.id)
    const r1Balance = (r1MovementsAfter ?? []).reduce((sum, m) => sum + Number(m.quantity_delta), 0)
    assert(r1Balance === 15000, `expected location 1 balance 12000 + 3000 = 15000 after receive, got ${r1Balance}`)
    console.log('Newly created location created, dispatched, and had a transfer received correctly (real stock movements on both ends) -- OK')

    console.log('\nBUSINESS_LOCATIONS_STAGING_VERIFY_OK')
  } finally {
    await browser.close()
    await cleanup()
  }
}

main().catch(async (error) => {
  console.error('BUSINESS_LOCATIONS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
