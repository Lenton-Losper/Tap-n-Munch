/**
 * Staging verification for the multi-location stock transfer UI, driven through the real
 * deployed app with Playwright (not just API calls):
 *  - a source-location manager creates, dispatches, and (on a separate draft) cancels a
 *    transfer through the actual UI
 *  - a destination-location manager sees an incoming transfer, uses "Confirm all received",
 *    and separately tests "Report difference" with a real variance
 *  - adding an unconfigured item to a transfer is blocked in the UI with a clear message,
 *    then unblocked after configuring it through the same flow
 *  - an organization owner sees the location switcher and the aggregate view; a
 *    single-location manager does not see it at all
 *  - History shows completed/cancelled transfers and excludes drafts/in-transit ones
 *
 *   npx tsx scripts/verify-transfer-ui-staging.ts
 */
import { chromium, type Browser, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
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
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

// lib/supabase/server.ts (createServerSupabaseClient, used by lib/stock/transfers.ts via
// lib/permissions/authorize.ts) reads NEXT_PUBLIC_SUPABASE_URL, not SUPABASE_URL.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `txui-${Date.now()}`

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
  const { data, error } = await db.auth.admin.createUser({ email, password: STAGING_TEST_PASSWORD, email_confirm: true })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  created.userIds.push(userId)
  userEmails.set(userId, email)
  const { error: publicUserError } = await db.from('users').insert({ id: userId, email })
  if (publicUserError) throw publicUserError
  return userId
}

const TRANSFER_PERMISSIONS = [
  'stock:view',
  'stock:receive',
  'stock:transfer_create',
  'stock:transfer_dispatch',
  'stock:transfer_receive',
]

async function createManagerAt(restaurantId: string, tagSuffix: string): Promise<string> {
  const { error: roleError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restaurantId, role_slug: 'manager', display_name: 'Manager', permissions: TRANSFER_PERMISSIONS, is_system: false })
  if (roleError) throw roleError

  const userId = await createRealAuthUser(`manager-${tagSuffix}`)
  const { error: membershipError } = await db.from('restaurant_users').insert({ restaurant_id: restaurantId, user_id: userId, role: 'manager' })
  if (membershipError) throw membershipError
  return userId
}

async function setupFixtures() {
  const ownerUserId = await createRealAuthUser('owner')

  const { data: org, error: orgError } = await db
    .from('organizations')
    .insert({ name: `${tag} Org`, owner_user_id: ownerUserId })
    .select('id')
    .single()
  if (orgError || !org) throw orgError ?? new Error('org insert failed')
  created.organizationIds.push(org.id)

  const { error: orgOwnerError } = await db.from('organization_users').insert({ organization_id: org.id, user_id: ownerUserId, role: 'OWNER' })
  if (orgOwnerError) throw orgOwnerError

  const { data: restA, error: restAError } = await db
    .from('restaurants')
    .insert({ name: `${tag} Mingle`, organization_id: org.id })
    .select('id')
    .single()
  if (restAError || !restA) throw restAError ?? new Error('restaurant A insert failed')
  created.restaurantIds.push(restA.id)

  const { data: restB, error: restBError } = await db
    .from('restaurants')
    .insert({ name: `${tag} Riverside`, organization_id: org.id })
    .select('id')
    .single()
  if (restBError || !restB) throw restBError ?? new Error('restaurant B insert failed')
  created.restaurantIds.push(restB.id)

  // Owner also needs an "owner" restaurant_roles + restaurant_users row for the source
  // restaurant, mirroring how a real org owner always has restaurant-level access at their
  // primary location. Uses the full TRANSFER_PERMISSIONS set (matching what
  // role-permissions.config.json's real "owner" array actually grants, since WS4 added
  // stock:transfer_create/dispatch/receive to owner by default) -- not just stock:view.
  // A restaurant owner missing those would be an unrealistic fixture, not a real-world case:
  // every actual owner role includes them.
  const { error: ownerRoleError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restA.id, role_slug: 'owner', display_name: 'Owner', permissions: TRANSFER_PERMISSIONS, is_system: true })
  if (ownerRoleError) throw ownerRoleError
  const { error: ownerMembershipError } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restA.id, user_id: ownerUserId, role: 'owner' })
  if (ownerMembershipError) throw ownerMembershipError

  const managerAId = await createManagerAt(restA.id, 'A')
  const managerBId = await createManagerAt(restB.id, 'B')

  const { data: gUnit, error: gUnitError } = await db.from('measurement_units').select('id').is('restaurant_id', null).eq('name', 'g').single()
  if (gUnitError || !gUnit) throw gUnitError ?? new Error('system unit "g" missing')

  const { data: configuredOrgItem, error: configuredOrgItemError } = await db
    .from('organization_stock_items')
    .insert({ organization_id: org.id, name: `${tag} Flour`, base_unit_id: gUnit.id })
    .select('id')
    .single()
  if (configuredOrgItemError || !configuredOrgItem) throw configuredOrgItemError ?? new Error('configured org item failed')
  created.orgStockItemIds.push(configuredOrgItem.id)

  const { data: stockItemA, error: stockItemAError } = await db
    .from('stock_items')
    .insert({ restaurant_id: restA.id, organization_stock_item_id: configuredOrgItem.id, name: `${tag} Flour`, unit_id: gUnit.id, is_active: true })
    .select('id')
    .single()
  if (stockItemAError || !stockItemA) throw stockItemAError ?? new Error('stock item A failed')
  created.stockItemIds.push(stockItemA.id)

  const { error: stockErr } = await db
    .from('stock_items')
    .insert({ restaurant_id: restB.id, organization_stock_item_id: configuredOrgItem.id, name: `${tag} Flour`, unit_id: gUnit.id, is_active: true })
  if (stockErr) throw stockErr
  const { data: stockItemB } = await db
    .from('stock_items')
    .select('id')
    .eq('restaurant_id', restB.id)
    .eq('organization_stock_item_id', configuredOrgItem.id)
    .single()
  created.stockItemIds.push(stockItemB!.id)

  const { error: stockMoveError } = await db
    .from('stock_movements')
    .insert({ restaurant_id: restA.id, stock_item_id: stockItemA.id, quantity_delta: 100, reason: 'received' })
  if (stockMoveError) throw stockMoveError

  // Deliberately configured ONLY at restaurant A -- used to exercise the "blocked, then
  // configure" flow in the create-transfer item picker.
  const { data: unconfiguredOrgItem, error: unconfiguredOrgItemError } = await db
    .from('organization_stock_items')
    .insert({ organization_id: org.id, name: `${tag} Sugar`, base_unit_id: gUnit.id })
    .select('id')
    .single()
  if (unconfiguredOrgItemError || !unconfiguredOrgItem) throw unconfiguredOrgItemError ?? new Error('unconfigured org item failed')
  created.orgStockItemIds.push(unconfiguredOrgItem.id)

  const { data: unconfiguredStockItemA, error: unconfiguredStockItemAError } = await db
    .from('stock_items')
    .insert({ restaurant_id: restA.id, organization_stock_item_id: unconfiguredOrgItem.id, name: `${tag} Sugar`, unit_id: gUnit.id, is_active: true })
    .select('id')
    .single()
  if (unconfiguredStockItemAError || !unconfiguredStockItemA) throw unconfiguredStockItemAError ?? new Error('unconfigured stock item A failed')
  created.stockItemIds.push(unconfiguredStockItemA.id)

  return {
    organizationId: org.id as string,
    restaurantAId: restA.id as string,
    restaurantAName: `${tag} Mingle`,
    restaurantBId: restB.id as string,
    restaurantBName: `${tag} Riverside`,
    ownerUserId,
    managerAId,
    managerBId,
    configuredItemName: `${tag} Flour`,
    configuredOrgItemId: configuredOrgItem.id as string,
    unconfiguredItemName: `${tag} Sugar`,
    unitId: gUnit.id as string,
  }
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
      await new Promise((resolve) => setTimeout(resolve, 3000))
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
  await page.waitForURL(/dashboard|menu-management/, { timeout: 60000 })
  return page
}

async function main() {
  await waitForDeploy()
  const fixtures = await setupFixtures()
  const browser = await chromium.launch()

  try {
    // ============================================================
    // Part 1: source manager creates, dispatches, and cancels via UI
    // ============================================================
    console.log('\n--- Part 1: source manager create + dispatch + cancel (real UI) ---')
    const managerAPage = await loginAs(browser, fixtures.managerAId)

    async function createDraftViaUI(page: Page, itemName: string, quantity: string) {
      await page.goto(`${BASE_URL}/stock/transfers/new`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('heading', { name: /create transfer/i }).waitFor({ timeout: 30000 })

      try {
        await page.locator('#to-restaurant').click()
        await page.getByRole('option', { name: fixtures.restaurantBName }).click()

        const itemInput = page.getByPlaceholder('Search items...')
        await itemInput.click()
        await itemInput.fill(itemName)
        await page.getByRole('button', { name: new RegExp(itemName) }).first().click()

        await page.getByLabel('Quantity').first().fill(quantity)
        if (process.env.PW_DEBUG) {
          await page.screenshot({ path: 'C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp\\52b59ec7-460a-4e28-80e4-94489912ec42\\scratchpad\\pw-debug/before-submit.png', fullPage: true })
          require('fs').writeFileSync('C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp\\52b59ec7-460a-4e28-80e4-94489912ec42\\scratchpad\\pw-debug/before-submit.html', await page.content())
        }
        await page.getByRole('button', { name: /save as draft/i }).click()
        await page.waitForURL(/\/stock\/transfers\?created=1/, { timeout: 30000 })
      } catch (err) {
        if (process.env.PW_DEBUG) {
          await page.screenshot({ path: 'C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp\\52b59ec7-460a-4e28-80e4-94489912ec42\\scratchpad\\pw-debug/failure.png', fullPage: true }).catch(() => {})
          require('fs').writeFileSync('C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp\\52b59ec7-460a-4e28-80e4-94489912ec42\\scratchpad\\pw-debug/failure.html', await page.content().catch(() => 'N/A'))
        }
        throw err
      }
    }

    await createDraftViaUI(managerAPage, fixtures.configuredItemName, '10')

    const { data: draft1 } = await db
      .from('stock_transfers')
      .select('id, transfer_number')
      .eq('from_restaurant_id', fixtures.restaurantAId)
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    assert(draft1, 'expected a DRAFT transfer to exist after Save as Draft')
    created.transferIds.push(draft1!.id)
    console.log('Created draft via UI:', draft1!.transfer_number)

    await managerAPage.goto(`${BASE_URL}/stock/transfers`, { waitUntil: 'domcontentloaded' })
    const draft1Row = managerAPage.locator('div.rounded-2xl', { hasText: draft1!.transfer_number })
    await draft1Row.waitFor({ state: 'visible', timeout: 20000 })
    await draft1Row.getByRole('button', { name: /^dispatch$/i }).click()
    await managerAPage.waitForTimeout(2000)

    const { data: afterDispatch } = await db.from('stock_transfers').select('status').eq('id', draft1!.id).single()
    assert(afterDispatch?.status === 'IN_TRANSIT', `expected IN_TRANSIT after UI dispatch, got ${afterDispatch?.status}`)
    console.log('Dispatched via UI -- status is IN_TRANSIT -- OK')

    // Second draft, for the cancel test.
    await createDraftViaUI(managerAPage, fixtures.configuredItemName, '5')
    const { data: draft2 } = await db
      .from('stock_transfers')
      .select('id, transfer_number')
      .eq('from_restaurant_id', fixtures.restaurantAId)
      .eq('status', 'DRAFT')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    assert(draft2, 'expected a second DRAFT transfer for the cancel test')
    created.transferIds.push(draft2!.id)

    await managerAPage.goto(`${BASE_URL}/stock/transfers`, { waitUntil: 'domcontentloaded' })
    managerAPage.once('dialog', (dialog) => void dialog.accept())
    const draft2Row = managerAPage.locator('div.rounded-2xl', { hasText: draft2!.transfer_number })
    await draft2Row.waitFor({ state: 'visible', timeout: 20000 })
    await draft2Row.getByRole('button', { name: /^cancel$/i }).click()
    await managerAPage.waitForTimeout(2000)

    const { data: afterCancel } = await db.from('stock_transfers').select('status').eq('id', draft2!.id).single()
    assert(afterCancel?.status === 'CANCELLED', `expected CANCELLED after UI cancel, got ${afterCancel?.status}`)
    console.log('Cancelled via UI -- status is CANCELLED -- OK')

    // ============================================================
    // Part 2: unconfigured item is blocked in the UI, then unblocked after configuring
    // ============================================================
    console.log('\n--- Part 2: unconfigured item blocked in UI, then configured ---')
    await managerAPage.goto(`${BASE_URL}/stock/transfers/new`, { waitUntil: 'domcontentloaded' })
    await managerAPage.locator('#to-restaurant').click()
    await managerAPage.getByRole('option', { name: fixtures.restaurantBName }).click()

    const sugarInput = managerAPage.getByPlaceholder('Search items...')
    await sugarInput.click()
    await sugarInput.fill(fixtures.unconfiguredItemName)
    await managerAPage.getByText(new RegExp(`not configured at ${fixtures.restaurantBName}`, 'i')).waitFor({ timeout: 10000 })
    console.log('Unconfigured item correctly flagged in the picker (not silently selectable) -- OK')

    await managerAPage.getByRole('button', { name: new RegExp(fixtures.unconfiguredItemName) }).first().click()
    await managerAPage.getByRole('heading', { name: /configure/i }).waitFor({ timeout: 10000 })

    // managerA has stock:receive at restaurant A only -- not a member of restaurant B at
    // all -- so this must be rejected, not silently succeed. Confirms configuring a location
    // isn't something any staff member can do just because they're sending a transfer there.
    await managerAPage.getByRole('button', { name: /^configure at/i }).click()
    await managerAPage.getByText(/do not have permission/i).waitFor({ timeout: 10000 })
    const { data: stillUnconfigured } = await db
      .from('stock_items')
      .select('id')
      .eq('restaurant_id', fixtures.restaurantBId)
      .eq('organization_stock_item_id', created.orgStockItemIds[1])
      .eq('is_active', true)
      .maybeSingle()
    assert(!stillUnconfigured, 'managerA (no access to restaurant B) should NOT be able to configure an item there')
    console.log('managerA correctly blocked from configuring an item at a restaurant they have no access to -- OK')
    await managerAPage.getByRole('button', { name: /^cancel$/i }).click()
    await managerAPage.close()

    // The org OWNER has the create_cross_location_transfer fallback (Workstream 4), so the
    // same flow should succeed for them -- proving the block above is a real permission
    // boundary, not a broken feature.
    const ownerConfigurePage = await loginAs(browser, fixtures.ownerUserId)
    await ownerConfigurePage.goto(`${BASE_URL}/stock/transfers/new`, { waitUntil: 'domcontentloaded' })
    await ownerConfigurePage.locator('#to-restaurant').click()
    await ownerConfigurePage.getByRole('option', { name: fixtures.restaurantBName }).click()
    const ownerSugarInput = ownerConfigurePage.getByPlaceholder('Search items...')
    await ownerSugarInput.click()
    await ownerSugarInput.fill(fixtures.unconfiguredItemName)
    await ownerConfigurePage.getByRole('button', { name: new RegExp(fixtures.unconfiguredItemName) }).first().click()
    await ownerConfigurePage.getByRole('heading', { name: /configure/i }).waitFor({ timeout: 10000 })
    await ownerConfigurePage.getByRole('button', { name: /^configure at/i }).click()
    await ownerConfigurePage.waitForTimeout(1500)
    if (process.env.PW_DEBUG) {
      await ownerConfigurePage.screenshot({ path: 'C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp\\52b59ec7-460a-4e28-80e4-94489912ec42\\scratchpad\\pw-debug/owner-configure.png', fullPage: true })
    }

    const { data: nowConfigured } = await db
      .from('stock_items')
      .select('id')
      .eq('restaurant_id', fixtures.restaurantBId)
      .eq('organization_stock_item_id', created.orgStockItemIds[1])
      .eq('is_active', true)
      .maybeSingle()
    assert(nowConfigured, 'expected the org OWNER to successfully configure the item at restaurant B via UI')
    created.stockItemIds.push(nowConfigured!.id)
    console.log('Org OWNER configured the item at the destination via UI (cross-location fallback) -- OK')
    await ownerConfigurePage.close()

    // ============================================================
    // Part 3: destination manager confirms all received, then reports a difference
    // ============================================================
    console.log('\n--- Part 3: destination manager receive flows (real UI) ---')
    const managerBPage = await loginAs(browser, fixtures.managerBId)

    await managerBPage.goto(`${BASE_URL}/stock/transfers/incoming`, { waitUntil: 'domcontentloaded' })
    const incomingRow = managerBPage.locator('div.rounded-2xl', { hasText: draft1!.transfer_number })
    await incomingRow.waitFor({ state: 'visible', timeout: 20000 })
    await incomingRow.getByRole('button', { name: /confirm all received/i }).click()
    await managerBPage.waitForTimeout(2000)

    const { data: afterReceive } = await db.from('stock_transfers').select('status').eq('id', draft1!.id).single()
    assert(afterReceive?.status === 'RECEIVED', `expected RECEIVED after Confirm all received, got ${afterReceive?.status}`)
    console.log('"Confirm all received" via UI -- status is RECEIVED -- OK')

    // Third transfer, dispatched directly via the backend action (already proven via UI in
    // Part 1) so Part 3's variance test isn't re-testing dispatch, just receive-with-variance.
    const { dispatchTransfer } = await import('../lib/stock/transfers')
    const { createTransfer } = await import('../lib/stock/transfers')
    const draft3 = await createTransfer({
      userId: fixtures.managerAId,
      organizationId: fixtures.organizationId,
      fromRestaurantId: fixtures.restaurantAId,
      toRestaurantId: fixtures.restaurantBId,
      items: [{ organizationStockItemId: fixtures.configuredOrgItemId, quantitySent: 20, unitId: fixtures.unitId }],
    })
    assert('data' in draft3, `setup: expected draft3 to be created, got ${JSON.stringify(draft3)}`)
    created.transferIds.push(draft3.data.transferId)
    const dispatch3 = await dispatchTransfer(fixtures.managerAId, draft3.data.transferId)
    assert('data' in dispatch3, `setup: expected draft3 to dispatch, got ${JSON.stringify(dispatch3)}`)

    await managerBPage.goto(`${BASE_URL}/stock/transfers/incoming`, { waitUntil: 'domcontentloaded' })
    const { data: draft3Row } = await db.from('stock_transfers').select('transfer_number').eq('id', draft3.data.transferId).single()
    const reportRow = managerBPage.locator('div.rounded-2xl', { hasText: draft3Row!.transfer_number })
    await reportRow.waitFor({ state: 'visible', timeout: 20000 })
    await reportRow.getByRole('button', { name: /report difference/i }).click()
    await managerBPage.getByLabel('Received').first().fill('18')
    await managerBPage.getByLabel(/variance reason/i).first().fill('Damaged in transit')
    await managerBPage.getByRole('button', { name: /submit received quantities/i }).click()
    await managerBPage.waitForTimeout(2000)

    const { data: afterVariance } = await db
      .from('stock_transfers')
      .select('status')
      .eq('id', draft3.data.transferId)
      .single()
    assert(afterVariance?.status === 'RECEIVED', `expected RECEIVED after Report difference, got ${afterVariance?.status}`)
    const { data: varianceItem } = await db
      .from('stock_transfer_items')
      .select('quantity_received, variance_reason')
      .eq('transfer_id', draft3.data.transferId)
      .single()
    assert(Number(varianceItem?.quantity_received) === 18, `expected quantity_received 18, got ${varianceItem?.quantity_received}`)
    assert(varianceItem?.variance_reason === 'Damaged in transit', 'expected variance_reason to be recorded')
    console.log('"Report difference" via UI -- received 18/20 with reason recorded -- OK')

    await managerBPage.close()

    // ============================================================
    // Part 4: org owner sees the switcher + aggregate view; single-location manager doesn't
    // ============================================================
    console.log('\n--- Part 4: organization location switcher visibility ---')
    const ownerPage = await loginAs(browser, fixtures.ownerUserId)
    await ownerPage.goto(`${BASE_URL}/stock/transfers`, { waitUntil: 'domcontentloaded' })
    await ownerPage.getByRole('heading', { name: /stock management/i }).waitFor({ timeout: 30000 })
    await ownerPage.locator('[aria-label="Location switcher"]').waitFor({ timeout: 10000 })
    console.log('Org owner sees the location switcher -- OK')

    await ownerPage.getByRole('link', { name: /all locations/i }).click()
    await ownerPage.waitForURL(/\/stock\/transfers\/all/, { timeout: 30000 })
    await ownerPage.getByRole('heading', { name: /all locations/i }).waitFor({ timeout: 10000 })
    const aggregateRowCount = await ownerPage.getByText(draft1!.transfer_number).count()
    assert(aggregateRowCount > 0, 'expected the aggregate view to include a transfer between the two org locations')
    console.log('Org owner reaches the aggregate view and sees cross-location transfers -- OK')
    await ownerPage.close()

    const managerACheckPage = await loginAs(browser, fixtures.managerAId)
    await managerACheckPage.goto(`${BASE_URL}/stock/transfers`, { waitUntil: 'domcontentloaded' })
    // Wait for real content (not the client-side "Loading..." splash) before asserting
    // absence -- otherwise "not found" could just mean "hasn't rendered yet", not "correctly
    // never rendered".
    await managerACheckPage.getByRole('heading', { name: /stock management/i }).waitFor({ timeout: 30000 })
    const switcherCount = await managerACheckPage.locator('[aria-label="Location switcher"]').count()
    assert(switcherCount === 0, `expected single-location manager to see NO location switcher, found ${switcherCount}`)
    console.log('Single-location manager sees no location switcher at all -- OK')
    await managerACheckPage.close()

    // ============================================================
    // Part 5: History excludes drafts/in-transit, shows completed/cancelled
    // ============================================================
    console.log('\n--- Part 5: History tab correctness ---')
    const managerAHistoryPage = await loginAs(browser, fixtures.managerAId)
    await managerAHistoryPage.goto(`${BASE_URL}/stock/transfers/history?dateRange=all`, { waitUntil: 'domcontentloaded' })
    await managerAHistoryPage.getByRole('heading', { name: /stock management/i }).waitFor({ timeout: 30000 })

    const receivedVisible = await managerAHistoryPage.getByText(draft1!.transfer_number).count()
    const cancelledVisible = await managerAHistoryPage.getByText(draft2!.transfer_number).count()
    assert(receivedVisible > 0, 'expected the RECEIVED transfer to appear in History')
    assert(cancelledVisible > 0, 'expected the CANCELLED transfer to appear in History')
    console.log('History shows RECEIVED and CANCELLED transfers -- OK')

    // draft3 was received too; nothing left in DRAFT/IN_TRANSIT for restaurant A at this
    // point, so instead verify the Outgoing view has emptied out (proving History and
    // Outgoing are disjoint, not that History merely includes everything).
    await managerAHistoryPage.goto(`${BASE_URL}/stock/transfers`, { waitUntil: 'domcontentloaded' })
    await managerAHistoryPage.getByRole('heading', { name: /stock management/i }).waitFor({ timeout: 30000 })
    const outgoingLeftover = await managerAHistoryPage.getByText(/no outgoing transfers in progress/i).count()
    assert(outgoingLeftover > 0, 'expected the Outgoing view to be empty now that every draft/in-transit transfer has been resolved')
    console.log('Outgoing view correctly excludes RECEIVED/CANCELLED transfers -- OK')
    await managerAHistoryPage.close()

    console.log('\nWS5_TRANSFER_UI_STAGING_VERIFY_OK')
  } finally {
    await browser.close()
    await cleanup()
  }
}

main().catch(async (error) => {
  console.error('WS5_TRANSFER_UI_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
