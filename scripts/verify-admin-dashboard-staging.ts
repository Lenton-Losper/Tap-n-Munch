/**
 * Staging verification for the Super Admin Dashboard core (issue #13).
 * Session injection follows the same proven pattern as
 * scripts/verify-authprovider-remount-staging.ts (magic link + verifyOtp +
 * SSR cookie chunking) rather than guessing at cookie formats.
 *
 *   VERIFY_APP_URL=http://localhost:3100 npx tsx scripts/verify-admin-dashboard-staging.ts
 */
import { createClient, type Session } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { chromium, type Page } from 'playwright'
import { createChunks } from '@supabase/ssr/dist/module/utils/chunker.js'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const APP = process.env.VERIFY_APP_URL || 'http://localhost:3100'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const BOOTSTRAP_ADMIN_EMAIL = 'xshadoey@gmail.com'
const NON_ADMIN_OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const KNOWN_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey = process.env.SUPABASE_ANON_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey || !anonKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const anonAuth = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

const AUTH_STORAGE_KEY = `sb-${STAGING_REF}-auth-token`

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

async function sessionViaMagicLink(email: string): Promise<Session> {
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError || !linkData.properties?.hashed_token) {
    throw linkError || new Error(`generateLink failed for ${email}`)
  }
  const { data: sess, error: otpErr } = await anonAuth.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session) throw otpErr || new Error(`verifyOtp failed for ${email}`)
  return sess.session
}

function encodeSessionForSsrCookie(session: Session): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
}

async function injectSupabaseSession(page: Page, session: Session) {
  const encoded = encodeSessionForSsrCookie(session)
  const chunks = createChunks(AUTH_STORAGE_KEY, encoded)
  const domain = new URL(APP).hostname
  const secure = APP.startsWith('https://')

  await page.context().addCookies(
    chunks.map(({ name, value }) => ({
      name,
      value,
      domain,
      path: '/',
      sameSite: 'Lax' as const,
      httpOnly: false,
      secure,
    })),
  )
}

async function main() {
  console.log('=== Super Admin Dashboard staging verification (#13) ===')

  const browser = await chromium.launch()
  try {
    // 1. Non-admin restaurant owner -> clean redirect away from /admin, not an error.
    const nonAdminSession = await sessionViaMagicLink(NON_ADMIN_OWNER_EMAIL)
    const nonAdminContext = await browser.newContext()
    const nonAdminPage = await nonAdminContext.newPage()
    await injectSupabaseSession(nonAdminPage, nonAdminSession)
    const nonAdminResponse = await nonAdminPage.goto(`${APP}/admin/restaurants`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    await nonAdminPage.waitForTimeout(500)
    const nonAdminUrl = nonAdminPage.url()
    record(
      '1-non-admin-redirected-cleanly',
      (nonAdminResponse?.status() ?? 0) < 500 && !nonAdminUrl.includes('/admin/restaurants'),
      `status=${nonAdminResponse?.status()} landed-on=${nonAdminUrl}`,
    )
    await nonAdminContext.close()

    // 2. Bootstrap platform admin -> real access, real content.
    const adminSession = await sessionViaMagicLink(BOOTSTRAP_ADMIN_EMAIL)
    const adminContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    await injectSupabaseSession(adminPage, adminSession)
    const adminResponse = await adminPage.goto(`${APP}/admin/restaurants`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    await adminPage.waitForTimeout(500)
    const adminUrl = adminPage.url()
    const bodyText = await adminPage.textContent('body')
    record(
      '2-bootstrap-admin-accesses-dashboard',
      (adminResponse?.status() ?? 0) === 200 && adminUrl.includes('/admin/restaurants'),
      `status=${adminResponse?.status()} landed-on=${adminUrl}`,
    )
    record(
      '3-restaurant-list-shows-real-data',
      !!bodyText && /restaurant/i.test(bodyText) && !bodyText.includes('Unable to load restaurants'),
      'page rendered real restaurant list content (not the error/empty state)',
    )
    await adminContext.close()
  } finally {
    await browser.close()
  }

  // 4. Independent DB-level check that real staging restaurants exist (not just "page didn't error").
  const { data: realRestaurants } = await admin.from('restaurants').select('id, name').limit(5)
  record(
    '4-real-staging-restaurants-exist',
    (realRestaurants?.length ?? 0) > 0,
    `found ${realRestaurants?.length ?? 0} real staging restaurants, e.g. "${realRestaurants?.[0]?.name}"`,
  )

  // 5. Feature flag toggle persists and is logged to platform_audit_logs, via the real
  //    PATCH route with a real bootstrap-admin bearer token.
  const apiSession = await sessionViaMagicLink(BOOTSTRAP_ADMIN_EMAIL)
  const { data: beforeFeatures } = await admin
    .from('restaurant_features')
    .select('kitchen_enabled')
    .eq('restaurant_id', KNOWN_RESTAURANT_ID)
    .maybeSingle()
  const newValue = !beforeFeatures?.kitchen_enabled

  const patchRes = await fetch(`${APP}/api/platform/restaurants/${KNOWN_RESTAURANT_ID}/features`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiSession.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kitchen_enabled: newValue }),
  })
  const patchJson = await patchRes.json().catch(() => ({}))
  record('5-feature-toggle-success', patchRes.status === 200 && patchJson.success === true, `status=${patchRes.status} body=${JSON.stringify(patchJson)}`)

  const { data: afterFeatures } = await admin
    .from('restaurant_features')
    .select('kitchen_enabled')
    .eq('restaurant_id', KNOWN_RESTAURANT_ID)
    .maybeSingle()
  record('5-feature-toggle-persisted', afterFeatures?.kitchen_enabled === newValue, `kitchen_enabled=${afterFeatures?.kitchen_enabled} expected=${newValue}`)

  const { data: auditRow } = await admin
    .from('platform_audit_logs')
    .select('actor_email, action, target_id, payload')
    .eq('target_id', KNOWN_RESTAURANT_ID)
    .eq('action', 'feature_flags_updated')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  record(
    '5-feature-toggle-audit-logged',
    auditRow?.actor_email === BOOTSTRAP_ADMIN_EMAIL && (auditRow?.payload as any)?.kitchen_enabled === newValue,
    `actor_email=${auditRow?.actor_email} payload=${JSON.stringify(auditRow?.payload)}`,
  )

  // Revert the toggle to leave staging state unchanged.
  await fetch(`${APP}/api/platform/restaurants/${KNOWN_RESTAURANT_ID}/features`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiSession.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kitchen_enabled: beforeFeatures?.kitchen_enabled ?? false }),
  })

  console.log('\nADMIN_DASHBOARD_STAGING_OK')
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
