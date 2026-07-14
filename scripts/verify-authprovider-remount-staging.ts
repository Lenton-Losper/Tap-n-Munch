/**
 * Staging investigation for #33: "AuthProvider remount on Settings navigation".
 *
 * The original observation (scripts/verify-sign-in-methods-staging.ts check6)
 * reached /settings via `page.goto('/settings#profile')`, which is always a
 * full browser navigation in Playwright — that alone would remount the whole
 * React tree (including AuthProvider in the root layout), independent of
 * which route it lands on. This script isolates the variable: does a real
 * in-app client-side navigation (clicking the sidebar "Settings" link, the
 * only way a real user reaches Settings) also cause a remount?
 *
 *   npx tsx scripts/verify-authprovider-remount-staging.ts
 */
import { randomUUID } from 'crypto'
import { createClient, type Session } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { chromium, type Page } from 'playwright'
import { createChunks } from '@supabase/ssr/dist/module/utils/chunker.js'
import { seedDefaultRestaurantRoles } from '@/lib/permissions/seed-default-roles'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  process.env.FLASHTAP_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const AUTH_STORAGE_KEY = `sb-${STAGING_REF}-auth-token`

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonAuth = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

type ConsoleEntry = { ts: string; type: string; text: string }

function attachConsoleTap(page: Page, sink: ConsoleEntry[]) {
  page.on('console', (msg) => {
    const entry = { ts: ts(), type: msg.type(), text: msg.text() }
    sink.push(entry)
    if (entry.text.includes('[AUTH_PROVIDER]')) {
      process.stdout.write(`[${entry.ts}] [browser:${entry.type}] ${entry.text}\n`)
    }
  })
}

function countAuthProviderMounts(entries: ConsoleEntry[]): number {
  return entries.filter((e) => e.text.includes('[AUTH_PROVIDER]') && /phase:\s*mount/i.test(e.text)).length
}

function countAuthProviderUnmounts(entries: ConsoleEntry[]): number {
  return entries.filter((e) => e.text.includes('[AUTH_PROVIDER]') && /phase:\s*unmount/i.test(e.text)).length
}

function encodeSessionForSsrCookie(session: Session): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
}

async function injectSupabaseSession(page: Page, session: Session) {
  const encoded = encodeSessionForSsrCookie(session)
  const chunks = createChunks(AUTH_STORAGE_KEY, encoded)
  const domain = new URL(BASE_URL).hostname
  const secure = BASE_URL.startsWith('https://')

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
  const tag = `authprovider-remount-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const userIds: string[] = []
  const restaurantIds: string[] = []

  console.log(`[${ts()}] === AuthProvider remount investigation (#33) ===`)

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (authError || !authData.user?.id) throw authError || new Error('createUser failed')
  const userId = authData.user.id
  userIds.push(userId)

  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({ name: `${tag} restaurant`, currency: 'NAD' })
    .select('id')
    .single()
  if (restErr || !restaurant?.id) throw restErr || new Error('restaurant insert failed')
  const restaurantId = String(restaurant.id)
  restaurantIds.push(restaurantId)

  await seedDefaultRestaurantRoles(admin, restaurantId)
  await admin.from('users').insert({
    id: userId,
    email,
    role: 'owner',
    full_name: 'AuthProvider Remount Test',
    restaurant_id: restaurantId,
  })
  await admin.from('restaurant_users').insert({ restaurant_id: restaurantId, user_id: userId, role: 'owner' })
  await admin.from('restaurants').update({ owner_id: userId }).eq('id', restaurantId)

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleEntries: ConsoleEntry[] = []
    attachConsoleTap(page, consoleEntries)

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    })
    if (linkError || !linkData.properties?.hashed_token) throw linkError || new Error('generateLink failed')

    const { data: sess, error: otpErr } = await anonAuth.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'magiclink',
    })
    if (otpErr || !sess.session) throw otpErr || new Error('verifyOtp failed')

    await injectSupabaseSession(page, sess.session)

    // One unavoidable full navigation to bootstrap the session (matches how a
    // real user's first page load — e.g. after email link click — works).
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 90_000 })
    await page.getByRole('link', { name: /settings/i }).first().waitFor({ timeout: 30_000 })

    const mountsAfterDashboardLoad = countAuthProviderMounts(consoleEntries)
    const unmountsAfterDashboardLoad = countAuthProviderUnmounts(consoleEntries)
    console.log(`[${ts()}] mounts after initial dashboard load: ${mountsAfterDashboardLoad}`)

    // The real navigation path: click the sidebar Settings <Link>, a
    // client-side transition — not page.goto().
    await page.getByRole('link', { name: /settings/i }).first().click()
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500) // let any effects/console logs flush

    const mountsAfterSettingsClick = countAuthProviderMounts(consoleEntries)
    const unmountsAfterSettingsClick = countAuthProviderUnmounts(consoleEntries)
    console.log(`[${ts()}] mounts after clicking Settings link: ${mountsAfterSettingsClick}`)
    console.log(`[${ts()}] unmounts after clicking Settings link: ${unmountsAfterSettingsClick}`)

    await assert(
      mountsAfterSettingsClick === mountsAfterDashboardLoad,
      `client-side Settings navigation does NOT remount AuthProvider (before=${mountsAfterDashboardLoad}, after=${mountsAfterSettingsClick})`,
    )
    await assert(
      unmountsAfterSettingsClick === unmountsAfterDashboardLoad,
      `client-side Settings navigation does NOT unmount AuthProvider (before=${unmountsAfterDashboardLoad}, after=${unmountsAfterSettingsClick})`,
    )

    console.log(`\n[${ts()}] Conclusion: the #33 remount is a page.goto() test artifact, not a real bug —`)
    console.log(`[${ts()}] real client-side navigation to Settings does not remount AuthProvider.`)
  } finally {
    await browser.close()
    for (const restaurantId of restaurantIds) {
      await admin.from('restaurants').delete().eq('id', restaurantId)
    }
    for (const uid of userIds) {
      await admin.from('users').delete().eq('id', uid)
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Investigation failed:`, error)
  process.exit(1)
})
