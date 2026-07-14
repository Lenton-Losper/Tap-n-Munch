/**
 * Staging verification for #16: Toaster was never mounted in the staff app
 * layout tree, so every toast() call silently did nothing. Fixed by commit
 * 52029dc ("Mount staff Toaster and gate ingredient validation on track
 * inventory"), which added <Toaster /> to components/dashboard/dashboard-shell.tsx.
 *
 * Radix's ToastPrimitives.Viewport always renders role="region"
 * aria-label="Notifications (F8)" regardless of whether any toast is
 * currently active, so its presence in the DOM is a reliable signal that
 * <Toaster /> is mounted — independent of triggering any specific toast().
 *
 *   npx tsx scripts/verify-toaster-mounted-staging.ts
 */
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
  const tag = `toaster-mount-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const userIds: string[] = []
  const restaurantIds: string[] = []

  console.log(`[${ts()}] === Toaster mount staging verification (#16) ===`)

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
    full_name: 'Toaster Mount Test',
    restaurant_id: restaurantId,
  })
  await admin.from('restaurant_users').insert({ restaurant_id: restaurantId, user_id: userId, role: 'owner' })
  await admin.from('restaurants').update({ owner_id: userId }).eq('id', restaurantId)

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()

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
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 90_000 })

    // Radix ToastPrimitives.Viewport always renders role="region"
    // aria-label="Notifications (F8)", regardless of active toasts.
    const viewport = page.getByRole('region', { name: /notifications/i })
    await viewport.waitFor({ state: 'attached', timeout: 15_000 })
    await assert(true, 'Toaster viewport (role=region, "Notifications (F8)") is present on /dashboard')

    // Also check a second staff route (Settings) since the fix mounts
    // Toaster in the shared DashboardShell used by all app/(staff) routes.
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 30_000 })
    const viewportOnSettings = page.getByRole('region', { name: /notifications/i })
    await viewportOnSettings.waitFor({ state: 'attached', timeout: 15_000 })
    await assert(true, 'Toaster viewport is also present on /settings (shared DashboardShell)')

    console.log(`\n[${ts()}] Toaster mount verification passed.`)
  } finally {
    await browser.close()
    for (const rId of restaurantIds) {
      await admin.from('restaurants').delete().eq('id', rId)
    }
    for (const uid of userIds) {
      await admin.from('users').delete().eq('id', uid)
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
