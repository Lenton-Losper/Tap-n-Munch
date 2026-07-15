/**
 * Staging verification: xshadoey@gmail.com's missing public.users row (platform_admins
 * bootstrap account) has been repaired. Confirms sign-in no longer shows "Account Data
 * Missing" and /admin is still accessible. Session injection follows the same proven
 * pattern as scripts/verify-authprovider-remount-staging.ts.
 *
 *   VERIFY_APP_URL=http://localhost:3100 npx tsx scripts/verify-platform-admin-public-user-repair-staging.ts
 */
import { createClient, type Session } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { chromium, type Page } from 'playwright'
import { createChunks } from '@supabase/ssr/dist/module/utils/chunker.js'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const APP = process.env.VERIFY_APP_URL || 'http://localhost:3100'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const EMAIL = 'xshadoey@gmail.com'

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
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkError || !linkData.properties?.hashed_token) throw linkError || new Error(`generateLink failed for ${email}`)
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
    chunks.map(({ name, value }) => ({ name, value, domain, path: '/', sameSite: 'Lax' as const, httpOnly: false, secure })),
  )
}

async function main() {
  console.log('=== Platform admin public.users repair verification ===')

  const session = await sessionViaMagicLink(EMAIL)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await injectSupabaseSession(page, session)

    // 1. Dashboard loads normally -- no "Account Data Missing" / repair prompt.
    const dashRes = await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1500)
    const dashBody = await page.textContent('body')
    record(
      '1-no-account-data-missing',
      !dashBody?.includes('Account Data Missing') && !dashBody?.includes('Repair My Account'),
      `status=${dashRes?.status()} url=${page.url()} bodyHasRepairPrompt=${dashBody?.includes('Repair My Account')}`,
    )

    // 2. /admin is still accessible for this platform admin.
    const adminRes = await page.goto(`${APP}/admin/restaurants`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1000)
    const adminUrl = page.url()
    record(
      '2-admin-still-accessible',
      (adminRes?.status() ?? 0) === 200 && adminUrl.includes('/admin/restaurants'),
      `status=${adminRes?.status()} landed-on=${adminUrl}`,
    )

    await context.close()
  } finally {
    await browser.close()
  }

  console.log('\nPLATFORM_ADMIN_REPAIR_STAGING_OK')
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
