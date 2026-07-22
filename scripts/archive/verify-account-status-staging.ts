/**
 * Staging E2E: accountStatus missing vs failed screens.
 *   npx tsx scripts/verify-account-status-staging.ts
 */
import { randomUUID } from 'crypto'
import { chromium, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const MISSING_TEST_EMAIL =
  process.env.MISSING_TEST_EMAIL || 'staging.manager.test@gmail.com'
const FAILED_TEST_EMAIL =
  process.env.FAILED_TEST_EMAIL || 'flashtap.staging.test@gmail.com'
const TEST_PASSWORD = STAGING_TEST_PASSWORD
const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT || 'bda0183'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

type ConsoleEntry = { ts: string; type: string; text: string }
type UsersRow = Record<string, unknown>
type RestaurantUserRow = Record<string, unknown>

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

function attachConsoleTap(page: Page, sink: ConsoleEntry[]) {
  page.on('console', (msg) => {
    const entry = { ts: ts(), type: msg.type(), text: msg.text() }
    sink.push(entry)
    process.stdout.write(`[${entry.ts}] [browser:${entry.type}] ${entry.text}\n`)
  })
}

async function getAuthUserId(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 })
  if (error) throw error
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!user?.id) throw new Error(`Auth user not found for ${email}`)
  return user.id
}

async function fetchUsersRow(userId: string): Promise<UsersRow | null> {
  const { data, error } = await admin.from('users').select('*').eq('id', userId).maybeSingle()
  if (error) throw error
  return data as UsersRow | null
}

async function fetchRestaurantUsers(userId: string): Promise<RestaurantUserRow[]> {
  const { data, error } = await admin.from('restaurant_users').select('*').eq('user_id', userId)
  if (error) throw error
  return (data ?? []) as RestaurantUserRow[]
}

async function deleteUsersRow(userId: string) {
  const { error } = await admin.from('users').delete().eq('id', userId)
  if (error) throw error
}

async function restoreUsersRow(row: UsersRow) {
  const { error } = await admin.from('users').upsert(row, { onConflict: 'id' })
  if (error) throw error
}

async function restoreRestaurantUsers(rows: RestaurantUserRow[]) {
  for (const row of rows) {
    const { error } = await admin.from('restaurant_users').upsert(row, {
      onConflict: 'id',
    })
    if (error) throw error
  }
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: /email/i }).fill(email)
  await page.getByRole('textbox', { name: /password/i }).fill(TEST_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
}

async function waitForDashboard(page: Page, timeoutMs = 45_000) {
  await page.waitForURL(/\/dashboard/, { timeout: timeoutMs })
  await page.getByRole('heading', { name: /live orders/i }).waitFor({ state: 'visible', timeout: 20_000 })
}

async function assertVersion() {
  const res = await fetch(`${BASE_URL}/api/version`)
  const body = (await res.json()) as { commit?: string }
  const commit = body.commit || ''
  console.log(`[${ts()}] /api/version commit=${commit}`)
  if (!commit.startsWith(EXPECTED_COMMIT)) {
    throw new Error(`Expected commit prefix ${EXPECTED_COMMIT}, got ${commit || '(missing)'}`)
  }
}

async function testMissingAccount(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\n' + '='.repeat(72))
  console.log('TEST 1 — missing account (users row deleted, auth user intact)')
  console.log('='.repeat(72))
  console.log(`[${ts()}] account=${MISSING_TEST_EMAIL}`)

  const userId = await getAuthUserId(MISSING_TEST_EMAIL)
  const backup = await fetchUsersRow(userId)
  if (!backup) throw new Error('Test account has no users row to backup — aborting')

  const restaurantUsersBackup = await fetchRestaurantUsers(userId)
  const orphanId = randomUUID()

  console.log(`[${ts()}] Backed up users row id=${userId}`)
  await deleteUsersRow(userId)
  const afterDelete = await fetchUsersRow(userId)
  if (afterDelete) throw new Error('users row still present after delete')

  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleEntries: ConsoleEntry[] = []
  attachConsoleTap(page, consoleEntries)

  let passed = false
  try {
    await signIn(page, MISSING_TEST_EMAIL)

    const missingHeading = page.getByRole('heading', { name: /account data missing/i })
    await missingHeading.waitFor({ state: 'visible', timeout: 30_000 })
    console.log(`[${ts()}] ✓ accountStatus=missing UI (Account Data Missing / Repair My Account)`)

    const repairButton = page.getByRole('button', { name: /repair my account/i })
    await repairButton.waitFor({ state: 'visible', timeout: 5_000 })

    const failedHeading = page.getByRole('heading', {
      name: /something went wrong loading your account/i,
    })
    if (await failedHeading.isVisible().catch(() => false)) {
      throw new Error('Unexpected failed screen instead of missing/repair screen')
    }

    const { error: orphanError } = await admin.from('users').insert({
      id: orphanId,
      email: backup.email,
      name: backup.name,
      full_name: backup.full_name ?? backup.name,
      phone: backup.phone ?? '',
      role: backup.role,
      restaurant_id: backup.restaurant_id,
      created_at: backup.created_at ?? new Date().toISOString(),
      last_login: backup.last_login ?? null,
    })
    if (orphanError) throw orphanError
    console.log(
      `[${ts()}] Inserted orphan users row id=${orphanId} before repair (sync-profile email relink path)`,
    )

    await repairButton.click()
    await page.waitForLoadState('load', { timeout: 60_000 })
    await waitForDashboard(page, 60_000)
    console.log(`[${ts()}] ✓ dashboard loaded after Repair My Account`)

    const restored = await fetchUsersRow(userId)
    if (!restored) throw new Error('users row not restored for auth id after repair')
    console.log(`[${ts()}] ✓ users row relinked to auth id=${userId}`)

    const orphanAfter = await fetchUsersRow(orphanId)
    if (orphanAfter) throw new Error('orphan users row still present after repair')

    passed = true
    return {
      passed: true,
      finalUrl: page.url(),
      consoleAuthLines: consoleEntries.filter((e) => /AuthProvider|accountStatus|LOAD_USER_DATA/i.test(e.text)),
    }
  } catch (err) {
    console.error(`[${ts()}] TEST 1 FAILED:`, err)
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      finalUrl: page.url(),
      consoleAuthLines: consoleEntries.filter((e) => /AuthProvider|accountStatus|LOAD_USER_DATA/i.test(e.text)),
    }
  } finally {
    const current = await fetchUsersRow(userId)
    if (!current) {
      console.log(`[${ts()}] Restoring users row from backup`)
      await restoreUsersRow(backup)
    }
    await admin.from('users').delete().eq('id', orphanId)
    if (restaurantUsersBackup.length > 0) {
      const currentMemberships = await fetchRestaurantUsers(userId)
      if (currentMemberships.length === 0) {
        console.log(`[${ts()}] Restoring restaurant_users membership`)
        await restoreRestaurantUsers(restaurantUsersBackup)
      }
    }
    await context.close()
  }
}

async function testFailedLoad(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\n' + '='.repeat(72))
  console.log('TEST 2 — failed load (users query forced to fail)')
  console.log('='.repeat(72))
  console.log(`[${ts()}] account=${FAILED_TEST_EMAIL}`)

  const userId = await getAuthUserId(FAILED_TEST_EMAIL)
  const row = await fetchUsersRow(userId)
  if (!row) throw new Error('Test account missing users row before test 2')

  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleEntries: ConsoleEntry[] = []
  attachConsoleTap(page, consoleEntries)

  let usersRouteActive = true

  await page.route('**/rest/v1/users**', async (route) => {
    if (!usersRouteActive) {
      await route.continue()
      return
    }
    const req = route.request()
    if (req.method() === 'GET' || req.method() === 'HEAD') {
      console.log(`[${ts()}] [route] forcing users query failure ${req.method()} ${req.url()}`)
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'investigation_forced_users_failure',
          message: 'simulated users lookup 500',
        }),
      })
      return
    }
    await route.continue()
  })

  try {
    await signIn(page, FAILED_TEST_EMAIL)

    const failedHeading = page.getByRole('heading', {
      name: /something went wrong loading your account/i,
    })
    await failedHeading.waitFor({ state: 'visible', timeout: 30_000 })
    console.log(`[${ts()}] ✓ accountStatus=failed UI (Something went wrong / Try Again)`)

    const repairHeading = page.getByRole('heading', { name: /account data missing/i })
    if (await repairHeading.isVisible().catch(() => false)) {
      throw new Error('Unexpected repair/missing screen instead of failed screen')
    }

    const tryAgain = page.getByRole('button', { name: /try again/i })
    await tryAgain.waitFor({ state: 'visible', timeout: 5_000 })

    usersRouteActive = false
    console.log(`[${ts()}] [route] users query failures disabled — retry should succeed`)

    await tryAgain.click()
    await waitForDashboard(page, 45_000)
    console.log(`[${ts()}] ✓ dashboard loaded after Try Again`)

    return {
      passed: true,
      finalUrl: page.url(),
      consoleAuthLines: consoleEntries.filter((e) => /AuthProvider|accountStatus|LOAD_USER_DATA|users lookup/i.test(e.text)),
    }
  } catch (err) {
    console.error(`[${ts()}] TEST 2 FAILED:`, err)
    return {
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      finalUrl: page.url(),
      consoleAuthLines: consoleEntries.filter((e) => /AuthProvider|accountStatus|LOAD_USER_DATA|users lookup/i.test(e.text)),
    }
  } finally {
    usersRouteActive = false
    await context.close()
  }
}

async function main() {
  console.log(`[${ts()}] BASE_URL=${BASE_URL}`)
  console.log(`[${ts()}] MISSING_TEST_EMAIL=${MISSING_TEST_EMAIL}`)
  console.log(`[${ts()}] FAILED_TEST_EMAIL=${FAILED_TEST_EMAIL}`)
  console.log(`[${ts()}] EXPECTED_COMMIT=${EXPECTED_COMMIT}`)

  await assertVersion()

  const browser = await chromium.launch({ headless: true })
  try {
    const test1 = await testMissingAccount(browser)
    const test2 = await testFailedLoad(browser)

    console.log('\n' + '#'.repeat(72))
    console.log('SUMMARY')
    console.log('#'.repeat(72))
    console.log(`Test 1 (missing): ${test1.passed ? 'PASS' : 'FAIL'}`)
    if (!test1.passed && 'error' in test1) console.log(`  error: ${test1.error}`)
    console.log(`  finalUrl: ${test1.finalUrl}`)
    console.log(`Test 2 (failed):  ${test2.passed ? 'PASS' : 'FAIL'}`)
    if (!test2.passed && 'error' in test2) console.log(`  error: ${test2.error}`)
    console.log(`  finalUrl: ${test2.finalUrl}`)

    if (!test1.passed || !test2.passed) {
      console.log('\n--- Test 1 auth console lines ---')
      for (const line of test1.consoleAuthLines) {
        console.log(`[${line.ts}] ${line.text}`)
      }
      console.log('\n--- Test 2 auth console lines ---')
      for (const line of test2.consoleAuthLines) {
        console.log(`[${line.ts}] ${line.text}`)
      }
      process.exit(1)
    }

    console.log('\nACCOUNT_STATUS_STAGING_OK')
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL`, err)
  process.exit(1)
})
