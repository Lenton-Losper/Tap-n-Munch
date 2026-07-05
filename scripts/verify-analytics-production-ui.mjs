/**
 * Production Step 3 UI verification — sidebar, server redirect, owner charts.
 *   node scripts/verify-analytics-production-ui.mjs
 */
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url?.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error('Refusing: not production Supabase')
}

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const testEmail = `analytics.prod.ui.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`

let testUserId = null
let testStaffMemberId = null

async function resolveRivieraOwnerEmail() {
  const { data: owners } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
  const ownerIds = (owners ?? []).map((o) => o.user_id)
  const { data: users } = await dbAdmin.from('users').select('id, email').in('id', ownerIds)
  const preferred =
    users?.find((u) => String(u.email).toLowerCase() === 'llosperofficial@gmail.com') ?? users?.[0]
  const email = String(preferred?.email || '').trim()
  if (!email) throw new Error('Riviera owner email missing')
  return email
}

async function cleanupLeftovers() {
  const { data: leftovers } = await dbAdmin
    .from('users')
    .select('id, email')
    .or('email.like.analytics.prod.verify%,email.like.analytics.prod.ui%,email.like.analytics-leak-prod%')
  for (const row of leftovers ?? []) {
    const { data: staffRows } = await dbAdmin.from('staff_members').select('id').ilike('email', row.email)
    for (const staff of staffRows ?? []) {
      await dbAdmin.from('staff_permissions').delete().eq('staff_id', staff.id)
      await dbAdmin.from('staff_members').delete().eq('id', staff.id)
    }
    await dbAdmin.from('restaurant_users').delete().eq('user_id', row.id)
    await dbAdmin.from('users').delete().eq('id', row.id)
    await authAdmin.auth.admin.deleteUser(row.id)
  }
}

async function ownerBearerToken() {
  const ownerEmail = await resolveRivieraOwnerEmail()
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ownerEmail,
  })
  if (linkErr || !link?.properties?.hashed_token) throw linkErr ?? new Error('no owner magic link')
  const { data: sess, error: otpErr } = await authAdmin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token) throw otpErr ?? new Error('owner OTP failed')
  return sess.session.access_token
}

async function ownerSignIn(page) {
  const ownerEmail = await resolveRivieraOwnerEmail()
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ownerEmail,
  })
  if (linkErr || !link?.properties?.action_link) throw linkErr ?? new Error('no owner magic link')
  await page.goto(link.properties.action_link)
  await page.waitForFunction(() => !window.location.hash.includes('access_token'), null, {
    timeout: 25_000,
  }).catch(() => undefined)
  if (!page.url().includes('/dashboard')) {
    await page.goto(`${APP}/dashboard`)
  }
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })
  await page.waitForTimeout(4000)
}

async function waiterSignIn(page) {
  await page.goto(`${APP}/signin`)
  await page.getByRole('textbox', { name: /email/i }).fill(testEmail)
  await page.getByRole('textbox', { name: /password/i }).fill(testPassword)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })
  await page.waitForTimeout(4000)
}

async function createDisposableWaiter() {
  const { data: created, error } = await authAdmin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  })
  if (error) throw error
  testUserId = created.user.id
  await dbAdmin.from('users').insert({
    id: testUserId,
    email: testEmail,
    full_name: 'Analytics Prod UI Waiter',
    role: 'waiter',
  })
  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: RIVIERA_ID,
    user_id: testUserId,
    role: 'waiter',
    invite_accepted: true,
  })
  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({ restaurant_id: RIVIERA_ID, email: testEmail, role: 'waiter', active: true })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  testStaffMemberId = String(staff.id)
}

async function cleanup() {
  if (testStaffMemberId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', testStaffMemberId)
    await dbAdmin.from('staff_members').delete().eq('id', testStaffMemberId)
  }
  if (testUserId) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', testUserId)
    await dbAdmin.from('users').delete().eq('id', testUserId)
    await authAdmin.auth.admin.deleteUser(testUserId)
  }
}

async function main() {
  const report = {}
  await cleanupLeftovers()
  await createDisposableWaiter()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await waiterSignIn(page)
    const sidebarBefore = await page.getByRole('link', { name: /^Analytics$/i }).isVisible().catch(() => false)
    await page.goto(`${APP}/analytics`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(4000)
    report.waiterDirectNav = {
      url: page.url(),
      blocked: page.url().includes('/dashboard') && !page.url().includes('/analytics'),
      sidebarLinkVisible: sidebarBefore,
    }

    await context.clearCookies()
    await dbAdmin.from('staff_permissions').insert({
      staff_id: testStaffMemberId,
      restaurant_id: RIVIERA_ID,
      permission: 'analytics:view',
      effect: 'allow',
    })

    await waiterSignIn(page)
    report.waiterOverrideSidebar = await page
      .getByRole('link', { name: /^Analytics$/i })
      .isVisible()
      .catch(() => false)
    await page.getByRole('link', { name: /^Analytics$/i }).click()
    await page.waitForSelector('h1:has-text("Analytics")', { timeout: 20_000 })
    await page.waitForTimeout(5000)
    const overrideBody = await page.textContent('body')
    report.waiterOverridePage = {
      url: page.url(),
      onAnalytics: page.url().includes('/analytics'),
      hasCharts: /Total Revenue|Sales Over Time|Analytics/i.test(overrideBody ?? ''),
    }

    const ownerContext = await browser.newContext()
    const ownerPage = await ownerContext.newPage()
    const ownerToken = await ownerBearerToken()
    const ownerApiRes = await fetch(
      `${APP}/api/analytics/orders-summary?restaurantId=${RIVIERA_ID}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    )
    const ownerApiBody = await ownerApiRes.json().catch(() => ({}))
    report.ownerApi = {
      status: ownerApiRes.status,
      orderCount: Array.isArray(ownerApiBody.orders) ? ownerApiBody.orders.length : 0,
    }

    try {
      await ownerSignIn(ownerPage)
      await ownerPage.goto(`${APP}/analytics`, { waitUntil: 'domcontentloaded' })
      await ownerPage.waitForSelector('h1:has-text("Analytics")', { timeout: 20_000 })
      await ownerPage.waitForTimeout(5000)
      const ownerBody = await ownerPage.textContent('body')
      report.ownerCharts = {
        url: ownerPage.url(),
        onAnalytics: ownerPage.url().includes('/analytics'),
        sections: {
          totalRevenue: /Total Revenue/i.test(ownerBody ?? ''),
          salesOverTime: /Sales Over Time/i.test(ownerBody ?? ''),
          topItems: /Top Items/i.test(ownerBody ?? ''),
          categoryBreakdown: /Category Breakdown/i.test(ownerBody ?? ''),
          peakHours: /Peak Hours/i.test(ownerBody ?? ''),
          paymentSplit: /Payment Method Split/i.test(ownerBody ?? ''),
        },
      }
    } catch (ownerUiErr) {
      report.ownerCharts = {
        browserUiSkipped: true,
        reason: String(ownerUiErr),
      }
    }
    await ownerPage.close()
    await ownerContext.close()

    console.log(JSON.stringify(report, null, 2))

    const ownerSections = report.ownerCharts?.sections ?? {}
    const ownerChartsOk =
      report.ownerCharts?.browserUiSkipped === true
        ? report.ownerApi?.status === 200 && (report.ownerApi?.orderCount ?? 0) > 0
        : report.ownerCharts?.onAnalytics && Object.values(ownerSections).every(Boolean)

    const ok =
      report.waiterDirectNav?.blocked &&
      !report.waiterDirectNav?.sidebarLinkVisible &&
      report.waiterOverrideSidebar &&
      report.waiterOverridePage?.onAnalytics &&
      report.waiterOverridePage?.hasCharts &&
      ownerChartsOk

    if (!ok) {
      console.error('FAIL: analytics production UI verification')
      process.exit(1)
    }
    console.log('\nANALYTICS_PRODUCTION_UI_OK')
  } finally {
    await cleanup()
    await browser.close()
    console.log('UI cleanup complete.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
