/**
 * Staging verification: view-only ordering points (menu-only QR, no tab/order path).
 *
 * Creates a real view-only ordering point via the live POST /api/admin/tables API,
 * confirms POST /api/tabs and POST /api/orders both reject it directly (not just a
 * disabled button), then drives a real headless browser through the actual landing/
 * browse pages -- including the case that matters most: a customer whose browser is
 * still carrying tab state from a completely different table scanning a view-only QR.
 * That stale-tab scenario is what caught two real race-condition bugs (both fixed) where
 * the page would fire a hard "session ended" redirect before the async view-only check
 * had resolved -- this script is what should catch a regression of either one.
 *
 *   npx tsx scripts/verify-view-only-qr-staging.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import fs from 'fs'

function loadEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
  )
}

const env = loadEnv('.env.test')
const STAGING_BASE = 'https://flashtap-staging.llosperofficial.workers.dev'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function getToken(admin, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const otp1 = await admin.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' })
  if (!otp1.error) return otp1.data.session.access_token
  const otp2 = await admin.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (otp2.error) throw otp2.error
  return otp2.data.session.access_token
}

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`PASS: ${label}`)
  } else {
    fail++
    console.log(`FAIL: ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const token = await getToken(admin, 'flashtap.staging.test@gmail.com')
  console.log('authenticated as staging test owner')

  // 1. Create a real view-only ordering point via the actual deployed API.
  const createRes = await fetch(`${STAGING_BASE}/api/admin/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: 'view_only', view_only_name: `Test Entrance ${Date.now()}`, location: 'Front noticeboard' }),
  })
  const created = await createRes.json()
  console.log('create view-only point:', createRes.status, JSON.stringify(created))
  check('POST /api/admin/tables creates a view-only point (200)', createRes.status === 200)
  check('created row has is_view_only=true', created?.table?.is_view_only === true)
  check('created row table_number is in the 5001+ range', Number(created?.table?.table_number) >= 5001, created?.table)
  const viewOnlyTableNumber = Number(created?.table?.table_number)
  const qrUrl = String(created?.table?.qr_code_url || '')
  check('qr_code_url points at the plain /v2 route with the reserved table number', qrUrl.includes(`/v2?table=${viewOnlyTableNumber}`), qrUrl)

  // 2. Hit POST /api/tabs directly against this table_number -- must reject, not just hide a button.
  const tabsRes = await fetch(`${STAGING_BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RESTAURANT_ID, tableNumber: viewOnlyTableNumber, sessionId: 'verify-session-1', displayName: 'Verify' }),
  })
  const tabsBody = await tabsRes.json().catch(() => ({}))
  console.log('POST /api/tabs against view-only point:', tabsRes.status, JSON.stringify(tabsBody))
  check('POST /api/tabs rejects a view-only table_number (403)', tabsRes.status === 403)

  // 3. Hit POST /api/orders directly against this table_number -- must reject even with no tabId,
  //    and also with a forged/nonexistent tabId (simulating a stale/replayed tab).
  const ordersRes = await fetch(`${STAGING_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurantId: RESTAURANT_ID,
      tableNumber: viewOnlyTableNumber,
      channel: 'table',
      items: [{ name: 'Test Item', quantity: 1, basePrice: 10, subtotal: 10 }],
      subtotal: 10,
      total: 10,
      sessionId: 'verify-session-1',
    }),
  })
  const ordersBody = await ordersRes.json().catch(() => ({}))
  console.log('POST /api/orders against view-only point (no tabId):', ordersRes.status, JSON.stringify(ordersBody))
  check('POST /api/orders rejects a view-only table_number with no tabId (403)', ordersRes.status === 403)

  const ordersWithForgedTabRes = await fetch(`${STAGING_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurantId: RESTAURANT_ID,
      tableNumber: viewOnlyTableNumber,
      channel: 'table',
      tabId: '00000000-0000-0000-0000-000000000000',
      items: [{ name: 'Test Item', quantity: 1, basePrice: 10, subtotal: 10 }],
      subtotal: 10,
      total: 10,
      sessionId: 'verify-session-1',
    }),
  })
  console.log('POST /api/orders against view-only point (forged tabId):', ordersWithForgedTabRes.status)
  check(
    'POST /api/orders rejects a view-only table_number even with a tabId present (403, not falling through to session-token/tab-lookup errors)',
    ordersWithForgedTabRes.status === 403,
  )

  // 4. Real browser: "scan" the QR (navigate to it cold) and confirm no ordering UI ever renders.
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(qrUrl, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    const bodyText = await page.textContent('body')
    check('landing page shows "View Menu" (view-only branch rendered)', bodyText.includes('View Menu'))
    check('landing page never shows "Create Tab"', !bodyText.includes('Create Tab'))
    check('landing page never shows "Join Tab"', !bodyText.includes('Join Tab'))
    check('landing page never shows a "Your name" prompt', !bodyText.includes('Your name'))

    await Promise.all([
      page.waitForURL(/\/browse/, { timeout: 10000 }).catch(() => {}),
      page.getByText('View Menu', { exact: true }).click().catch(() => page.getByRole('button', { name: /View Menu/ }).click()),
    ])
    await page.waitForTimeout(2000)

    const browseText = await page.textContent('body')
    check('browse page never shows "Create a tab to start ordering"', !browseText.includes('Create a tab to start ordering'))
    check('browse page never shows per-item "Create tab to order"', !browseText.includes('Create tab to order'))
    check('browse page never shows "My Orders"', !browseText.includes('My Orders'))
    check('browse page never shows a "Receipt" button', !browseText.includes('Receipt'))

    const addButtons = await page.locator('button[aria-label^="Add "]').all()
    let anyEnabled = false
    for (const btn of addButtons) {
      if (await btn.isEnabled()) anyEnabled = true
    }
    check(`all ${addButtons.length} Add-to-cart buttons are disabled`, addButtons.length === 0 || !anyEnabled)

    // 5. Stale-tab scenario: seed localStorage with a tab id from a DIFFERENT (fake) table,
    //    then reload the same view-only URL cold and confirm it still renders clean.
    await page.evaluate(() => {
      localStorage.setItem('flashtap_tab_id', '11111111-1111-1111-1111-111111111111')
      localStorage.setItem('flashtap_table', '3')
      localStorage.setItem('flashtap_session_v1', 'sess_stale-from-table-3')
      localStorage.setItem('flashtap_session_table_v1', '3')
    })
    await page.goto(qrUrl, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)
    const staleLandingText = await page.textContent('body')
    if (!staleLandingText.includes('View Menu')) {
      console.log('--- unexpected stale-landing body text (first 300 chars) ---')
      console.log(staleLandingText.slice(0, 300))
    }
    check('with stale tab-3 localStorage present, landing page still shows clean "View Menu" (not Rejoin/tab UI)', staleLandingText.includes('View Menu'))
    check('with stale tab-3 localStorage present, landing page does not show "Rejoin"', !staleLandingText.includes('Rejoin'))

    await page.goto(`${STAGING_BASE}/menu/${RESTAURANT_ID}/browse?table=${viewOnlyTableNumber}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    const staleBrowseText = await page.textContent('body')
    check('with stale tab-3 localStorage present, browse page still hides "Create a tab" prompt', !staleBrowseText.includes('Create a tab to start ordering'))
    check('with stale tab-3 localStorage present, browse page does not show an open-tab banner ("Tab open")', !staleBrowseText.includes('Tab open'))
    const staleAddButtons = await page.locator('button[aria-label^="Add "]').all()
    let staleAnyEnabled = false
    for (const btn of staleAddButtons) {
      if (await btn.isEnabled()) staleAnyEnabled = true
    }
    check('with stale tab-3 localStorage present, Add-to-cart buttons are still disabled', staleAddButtons.length === 0 || !staleAnyEnabled)

    const localStorageAfter = await page.evaluate(() => ({
      tabId: localStorage.getItem('flashtap_tab_id'),
      table: localStorage.getItem('flashtap_table'),
    }))
    console.log('localStorage after landing on view-only QR:', JSON.stringify(localStorageAfter))
    check('the stale tab_id was actually scrubbed from localStorage, not just masked in rendering', !localStorageAfter.tabId)
  } finally {
    await browser.close()
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
