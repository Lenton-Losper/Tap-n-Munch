/**
 * Staging verification: Billing settings tab + billing-profile API.
 *   npx tsx scripts/verify-billing-settings-staging.ts
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const STAGING_BASE = 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD
const KITCHEN_EMAIL = 'staging.kitchen.test@gmail.com'
const KITCHEN_PASSWORD = STAGING_TEST_PASSWORD

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TEST_PROFILE = {
  registration_number: 'STG-REG-88421',
  vat_number: 'STG-VAT-99102',
  bank_name: 'First National Bank',
  bank_account_name: 'FlashTap Staging Test',
  bank_account_number: '62123456789',
  bank_branch_code: '281872',
}

async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  return data.session.access_token
}

async function cleanupBillingProfile() {
  await admin.from('restaurant_billing_profiles').delete().eq('restaurant_id', RESTAURANT_ID)
}

async function login(page: import('playwright').Page, email: string, password: string) {
  await page.goto(`${STAGING_BASE}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(/\/(dashboard|settings|menu-management)/, { timeout: 90000 })
}

async function waitForSettingsTabs(page: import('playwright').Page) {
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 60000 })
  await page.locator('nav[aria-label="Settings sections"] button').first().waitFor({
    timeout: 60000,
  })
}

async function main() {
  const results: Record<string, unknown> = {}

  await cleanupBillingProfile()

  try {
    const browser = await chromium.launch({ headless: true })

    // --- Check 1: Owner UI save + GET round-trip ---
    const check1: Record<string, unknown> = {}
    const ownerContext = await browser.newContext()
    const ownerPage = await ownerContext.newPage()

    try {
      await login(ownerPage, OWNER_EMAIL, OWNER_PASSWORD)
      await ownerPage.goto(`${STAGING_BASE}/settings`, { waitUntil: 'domcontentloaded' })
      await waitForSettingsTabs(ownerPage)

      const tabLabels = await ownerPage
        .locator('nav[aria-label="Settings sections"] button')
        .allTextContents()
      check1.tabLabels = tabLabels
      check1.billingTabVisible = tabLabels.some((t) => /billing/i.test(t))

      await ownerPage.getByRole('button', { name: 'Billing' }).click()
      await ownerPage.waitForURL(/#billing/, { timeout: 10000 })
      await ownerPage.locator('#billing-registration-number').fill(TEST_PROFILE.registration_number)
      await ownerPage.locator('#billing-vat-number').fill(TEST_PROFILE.vat_number)
      await ownerPage.locator('#billing-bank-name').fill(TEST_PROFILE.bank_name)
      await ownerPage.locator('#billing-bank-account-name').fill(TEST_PROFILE.bank_account_name)
      await ownerPage.locator('#billing-bank-account-number').fill(TEST_PROFILE.bank_account_number)
      await ownerPage.locator('#billing-bank-branch-code').fill(TEST_PROFILE.bank_branch_code)
      await ownerPage.getByRole('button', { name: /save billing details/i }).click()
      await ownerPage.getByText('Billing saved', { exact: true }).waitFor({
        timeout: 15000,
      })
      check1.saveToastSeen = true

      await ownerPage.reload({ waitUntil: 'domcontentloaded' })
      await waitForSettingsTabs(ownerPage)
      await ownerPage.getByRole('button', { name: 'Billing' }).click()
      await ownerPage.waitForURL(/#billing/, { timeout: 10000 })
      check1.reloadedValues = {
        registration_number: await ownerPage.locator('#billing-registration-number').inputValue(),
        vat_number: await ownerPage.locator('#billing-vat-number').inputValue(),
        bank_name: await ownerPage.locator('#billing-bank-name').inputValue(),
        bank_account_name: await ownerPage.locator('#billing-bank-account-name').inputValue(),
        bank_account_number: await ownerPage.locator('#billing-bank-account-number').inputValue(),
        bank_branch_code: await ownerPage.locator('#billing-bank-branch-code').inputValue(),
      }

      const ownerToken = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
      const getRes = await fetch(
        `${STAGING_BASE}/api/admin/restaurants/${RESTAURANT_ID}/billing-profile`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      )
      const getPayload = await getRes.json()
      check1.apiGetStatus = getRes.status
      check1.apiGetProfile = getPayload.billingProfile

      check1.pass =
        Boolean(check1.billingTabVisible) &&
        Boolean(check1.saveToastSeen) &&
        Object.entries(TEST_PROFILE).every(
          ([k, v]) => (check1.reloadedValues as Record<string, string>)[k] === v,
        ) &&
        getRes.ok &&
        Object.entries(TEST_PROFILE).every(
          ([k, v]) => getPayload.billingProfile?.[k] === v,
        )
    } finally {
      await ownerContext.close()
    }

    // --- Check 2: Kitchen — no Billing tab (kitchen lacks settings:read → redirect) ---
    const check2: Record<string, unknown> = {}
    const kitchenContext = await browser.newContext()
    const kitchenPage = await kitchenContext.newPage()
    try {
      await login(kitchenPage, KITCHEN_EMAIL, KITCHEN_PASSWORD)
      await kitchenPage.goto(`${STAGING_BASE}/settings`, { waitUntil: 'domcontentloaded' })
      await kitchenPage.waitForTimeout(2000)
      check2.finalUrl = kitchenPage.url()
      const onSettings = kitchenPage.url().includes('/settings')
      check2.onSettingsPage = onSettings
      if (onSettings) {
        await waitForSettingsTabs(kitchenPage)
        const tabLabels = await kitchenPage
          .locator('nav[aria-label="Settings sections"] button')
          .allTextContents()
        check2.tabLabels = tabLabels
        check2.billingTabVisible = tabLabels.some((t) => /billing/i.test(t))
      } else {
        check2.tabLabels = []
        check2.billingTabVisible = false
      }
      check2.pass = !check2.billingTabVisible
    } finally {
      await kitchenContext.close()
      await browser.close()
    }

    // --- Check 3: Validation — invalid bank_account_number (seed valid row first) ---
    const ownerToken = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
    const seedRes = await fetch(
      `${STAGING_BASE}/api/admin/restaurants/${RESTAURANT_ID}/billing-profile`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(TEST_PROFILE),
      },
    )
    if (!seedRes.ok) {
      throw new Error(`Failed to seed billing profile: ${seedRes.status}`)
    }

    const invalidRes = await fetch(
      `${STAGING_BASE}/api/admin/restaurants/${RESTAURANT_ID}/billing-profile`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bank_account_number: 'ABC123' }),
      },
    )
    const invalidPayload = await invalidRes.json()
    const { data: afterInvalid } = await admin
      .from('restaurant_billing_profiles')
      .select('bank_account_number')
      .eq('restaurant_id', RESTAURANT_ID)
      .maybeSingle()

    results.check3_validation = {
      pass:
        invalidRes.status === 400 &&
        String(invalidPayload.error || '').toLowerCase().includes('bank_account_number') &&
        afterInvalid?.bank_account_number === TEST_PROFILE.bank_account_number,
      status: invalidRes.status,
      error: invalidPayload.error ?? null,
      dbBankAccountNumber: afterInvalid?.bank_account_number ?? null,
    }

    // --- Check 4: Auth bypass — no Authorization header ---
    const noAuthRes = await fetch(
      `${STAGING_BASE}/api/admin/restaurants/${RESTAURANT_ID}/billing-profile`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_number: 'HACK' }),
      },
    )
    const noAuthPayload = await noAuthRes.json()
    results.check4_auth_bypass = {
      pass: noAuthRes.status === 401,
      status: noAuthRes.status,
      error: noAuthPayload.error ?? null,
    }

    results.check1_owner_save_roundtrip = check1
    results.check2_kitchen_tab_hidden = check2
    results.deployCommit = 'eb985d2'

    console.log(JSON.stringify(results, null, 2))

    const allPass = [
      check1.pass,
      check2.pass,
      (results.check3_validation as { pass: boolean }).pass,
      (results.check4_auth_bypass as { pass: boolean }).pass,
    ].every(Boolean)
    if (!allPass) {
      console.error('BILLING_SETTINGS_STAGING_FAIL')
      process.exitCode = 1
    } else {
      console.log('BILLING_SETTINGS_STAGING_OK')
    }
  } finally {
    await cleanupBillingProfile()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
