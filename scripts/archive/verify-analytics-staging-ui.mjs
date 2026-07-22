/**
 * Playwright UI checks for analytics server-side page guard (cookie sessions).
 * Run after verify-analytics-staging.ts API checks:
 *   node scripts/verify-analytics-staging-ui.mjs
 */
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })


const STAGING_TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD?.trim()
if (!STAGING_TEST_PASSWORD) {
  throw new Error('Refusing: STAGING_TEST_PASSWORD is not set (.env.test)')
}

const STAGING =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const RESTA = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const KITCHEN_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const KITCHEN_EMAIL = 'staging.kitchen.test@gmail.com'
const KITCHEN_PASSWORD = STAGING_TEST_PASSWORD
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function ensureStaffMemberId() {
  const { data: existing } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', RESTA)
    .ilike('email', KITCHEN_EMAIL)
    .maybeSingle()
  if (existing?.id) return String(existing.id)
  const { data: inserted, error } = await admin
    .from('staff_members')
    .insert({ restaurant_id: RESTA, email: KITCHEN_EMAIL, role: 'waiter', active: true })
    .select('id')
    .single()
  if (error) throw error
  return String(inserted.id)
}

async function setRole(role) {
  await admin
    .from('restaurant_users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('user_id', KITCHEN_USER_ID)
    .eq('restaurant_id', RESTA)
  await admin.from('staff_members').update({ role }).eq('restaurant_id', RESTA).ilike('email', KITCHEN_EMAIL)
}

async function clearOverrides(staffMemberId) {
  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
}

async function signIn(page, email, password) {
  await page.goto(`${STAGING}/signin`)
  await page.getByRole('textbox', { name: /email/i }).fill(email)
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
  await page.waitForTimeout(4000)
}

async function openAnalyticsFromSidebar(page) {
  const link = page.getByRole('link', { name: /^Analytics$/i })
  await link.waitFor({ state: 'visible', timeout: 10_000 })
  await link.click()
  await page.waitForTimeout(6000)
}

async function main() {
  const staffMemberId = await ensureStaffMemberId()
  const report = {}
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await clearOverrides(staffMemberId)
    await setRole('waiter')

    await signIn(page, KITCHEN_EMAIL, KITCHEN_PASSWORD)
    const sidebarLinkVisible = await page.getByRole('link', { name: /^Analytics$/i }).isVisible().catch(() => false)
    await page.goto(`${STAGING}/analytics`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(4000)
    report.waiterDirectNav = {
      url: page.url(),
      blocked: page.url().includes('/dashboard') && !page.url().includes('/analytics'),
      sidebarLinkVisible,
    }

    await context.clearCookies()
    await clearOverrides(staffMemberId)
    await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: RESTA,
      permission: 'analytics:view',
      effect: 'allow',
    })

    await signIn(page, KITCHEN_EMAIL, KITCHEN_PASSWORD)
    report.waiterOverrideSidebar = await page
      .getByRole('link', { name: /^Analytics$/i })
      .isVisible()
      .catch(() => false)

    await openAnalyticsFromSidebar(page)
    const overrideBody = await page.textContent('body')
    report.waiterOverrideDirectNav = {
      url: page.url(),
      onAnalytics: page.url().includes('/analytics'),
      hasCharts: /Total Revenue|This Week|This Month|Item of the/i.test(overrideBody ?? ''),
    }

    await context.clearCookies()
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD)
    await openAnalyticsFromSidebar(page)
    const ownerBody = await page.textContent('body')
    report.ownerCharts = {
      url: page.url(),
      onAnalytics: page.url().includes('/analytics'),
      hasCharts: /Total Revenue|This Week|This Month|Item of the/i.test(ownerBody ?? ''),
      hasAnalyticsHeading: /Analytics/i.test((await page.locator('h1').first().textContent()) ?? ''),
    }

    console.log(JSON.stringify(report, null, 2))

    const ok =
      report.waiterDirectNav?.blocked &&
      !report.waiterDirectNav?.sidebarLinkVisible &&
      report.waiterOverrideSidebar &&
      report.waiterOverrideDirectNav?.onAnalytics &&
      report.waiterOverrideDirectNav?.hasCharts &&
      report.ownerCharts?.onAnalytics &&
      report.ownerCharts?.hasCharts &&
      report.ownerCharts?.hasAnalyticsHeading

    if (!ok) {
      console.error('FAIL: analytics staging UI verification')
      process.exit(1)
    }
    console.log('\nANALYTICS_STAGING_UI_OK')
  } finally {
    await clearOverrides(staffMemberId)
    await setRole('kitchen')
    await browser.close()
    console.log('UI cleanup complete.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
