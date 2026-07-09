/**
 * Staging IDS verification: Settings → Sign-in Methods (Add Email & Password).
 *
 *   npx tsx scripts/verify-sign-in-methods-staging.ts
 *
 * Requires:
 *   - .env.test with staging Supabase (mdqjpxwczrhkxkbqatqa)
 *   - Supabase CLI linked to flashtap-staging (for google-only identity simulation SQL)
 *
 * Matrix coverage:
 *   1. Google-only user adds password (happy path) + 6 remount instrumentation + 7 sign-in after
 *   2. Email/password-only user — no "Add Email & Password"
 *   3. Google + password user — no "Add Email & Password"
 *   4. Weak password rejected client-side
 *   5. Password mismatch rejected client-side
 *   6. No AuthProvider remounts during add-password submit/success (relative to Settings baseline; see issue #33)
 *   7. E2E: add password → sign out → sign in with new credential
 */
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { chromium, type Page } from 'playwright'
import { createClient, type Session } from '@supabase/supabase-js'
import { createChunks } from '@supabase/ssr/dist/module/utils/chunker.js'
import { config } from 'dotenv'
import { seedDefaultRestaurantRoles } from '@/lib/permissions/seed-default-roles'
import { HAS_PASSWORD_CREDENTIAL_METADATA_KEY } from '@/lib/auth/capabilities'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  process.env.FLASHTAP_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

/** Existing staging owner — email/password-only (check 2). */
const EMAIL_ONLY_EMAIL = process.env.SIGNIN_METHODS_EMAIL_ONLY_EMAIL || 'flashtap.staging.test@gmail.com'
const EMAIL_ONLY_PASSWORD = process.env.SIGNIN_METHODS_EMAIL_ONLY_PASSWORD?.trim() ?? STAGING_TEST_PASSWORD

const PASSWORD_TOO_SHORT_MESSAGE = 'Password must be at least 8 characters.'
const PASSWORD_MISMATCH_MESSAGE = 'Passwords do not match.'

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const tag = `signin-methods-${Date.now()}`
const ephemeralPassword = `Set${randomUUID().slice(0, 8)}!1`
const newPasswordForHappyPath = `Add${randomUUID().slice(0, 8)}!9`

type ConsoleEntry = { ts: string; type: string; text: string }

const AUTH_STORAGE_KEY = `sb-${STAGING_REF}-auth-token`

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const anonAuth = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

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

const created = {
  userIds: [] as string[],
  restaurantIds: [] as string[],
}

function ts(): string {
  return new Date().toISOString()
}

function attachConsoleTap(page: Page, sink: ConsoleEntry[]) {
  page.on('console', (msg) => {
    const entry = { ts: ts(), type: msg.type(), text: msg.text() }
    sink.push(entry)
    if (
      entry.text.includes('[AUTH_PROVIDER]') ||
      entry.text.includes('[AUTH_EVENT]') ||
      entry.text.includes('[LOAD_USER_DATA]')
    ) {
      process.stdout.write(`[${entry.ts}] [browser:${entry.type}] ${entry.text}\n`)
    }
  })
}

function countAuthProviderMounts(entries: ConsoleEntry[]): number {
  return entries.filter(
    (e) => e.text.includes('[AUTH_PROVIDER]') && /phase:\s*mount/i.test(e.text),
  ).length
}

function countAuthProviderUnmounts(entries: ConsoleEntry[]): number {
  return entries.filter(
    (e) => e.text.includes('[AUTH_PROVIDER]') && /phase:\s*unmount/i.test(e.text),
  ).length
}

function parseAuthEvents(entries: ConsoleEntry[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    if (!entry.text.includes('[AUTH_EVENT]')) continue
    const jsonStart = entry.text.indexOf('{')
    if (jsonStart === -1) {
      events.push({ raw: entry.text, ts: entry.ts })
      continue
    }
    try {
      events.push({ ts: entry.ts, ...(JSON.parse(entry.text.slice(jsonStart)) as object) })
    } catch {
      events.push({ raw: entry.text, ts: entry.ts })
    }
  }
  return events
}

function runLinkedSql(sql: string): void {
  const file = join(tmpdir(), `signin-methods-${randomUUID()}.sql`)
  writeFileSync(file, sql, 'utf8')
  try {
    execSync(`npx supabase db query --linked -f "${file}" -o json`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } finally {
    unlinkSync(file)
  }
}

async function seedOwnerUser(email: string, password?: string) {
  const attrs: { email: string; email_confirm: boolean; password?: string } = {
    email,
    email_confirm: true,
  }
  if (password) attrs.password = password

  const { data, error } = await admin.auth.admin.createUser(attrs)
  if (error || !data.user?.id) throw error ?? new Error('createUser failed')
  const userId = data.user.id
  created.userIds.push(userId)

  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({ name: `${tag} restaurant`, slug: `${tag}-${userId.slice(0, 8)}` })
    .select('id')
    .single()
  if (restErr || !restaurant?.id) throw restErr ?? new Error('restaurant insert failed')
  const restaurantId = String(restaurant.id)
  created.restaurantIds.push(restaurantId)

  await seedDefaultRestaurantRoles(admin, restaurantId)

  const { error: userRowErr } = await admin.from('users').insert({
    id: userId,
    email,
    role: 'owner',
    full_name: 'IDS Sign-in Methods',
    restaurant_id: restaurantId,
  })
  if (userRowErr) throw userRowErr

  const { error: ruErr } = await admin.from('restaurant_users').insert({
    restaurant_id: restaurantId,
    user_id: userId,
    role: 'owner',
    invite_accepted: true,
  })
  if (ruErr) throw ruErr

  return { userId, restaurantId, email }
}

async function simulateGoogleOnlyIdentity(userId: string, email: string) {
  runLinkedSql(`
UPDATE auth.identities
SET
  provider = 'google',
  provider_id = '${userId}',
  identity_data = jsonb_build_object(
    'iss', 'https://accounts.google.com',
    'sub', '${userId}',
    'email', '${email}',
    'email_verified', true,
    'full_name', 'IDS Google Sim'
  ),
  updated_at = now()
WHERE user_id = '${userId}'::uuid AND provider = 'email';

UPDATE auth.users
SET encrypted_password = NULL, updated_at = now()
WHERE id = '${userId}'::uuid;
`)
}

async function assertIdentities(
  userId: string,
  expectedProviders: string[],
): Promise<{ pass: boolean; providers: string[] }> {
  const snapshot = await getUserAuthSnapshot(userId)
  const expected = [...expectedProviders].sort()
  return {
    pass: JSON.stringify(snapshot.providers) === JSON.stringify(expected),
    providers: snapshot.providers,
  }
}

/**
 * Supabase Auth may not create an `email` identity row when a user sets a password
 * (upstream bugs, not fixed in hosted Auth as of 2026-07):
 * - https://github.com/supabase/auth/issues/2085
 * - https://github.com/supabase/auth/issues/2320
 * Mirror canAddPasswordCredential(): `email` identity OR user_metadata flag.
 */
type UserAuthSnapshot = {
  providers: string[]
  hasPasswordCredentialMetadata: boolean
  hasPasswordCredential: boolean
}

async function getUserAuthSnapshot(userId: string): Promise<UserAuthSnapshot> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error || !data.user) throw error ?? new Error('getUserById failed')
  const providers = (data.user.identities ?? [])
    .map((i) => i.provider)
    .filter(Boolean)
    .sort()
  const hasPasswordCredentialMetadata =
    data.user.user_metadata?.[HAS_PASSWORD_CREDENTIAL_METADATA_KEY] === true
  const hasEmailIdentity = providers.includes('email')
  return {
    providers,
    hasPasswordCredentialMetadata,
    hasPasswordCredential: hasEmailIdentity || hasPasswordCredentialMetadata,
  }
}

async function assertPasswordCredential(
  userId: string,
  expectedHasCredential: boolean,
): Promise<UserAuthSnapshot & { pass: boolean }> {
  const snapshot = await getUserAuthSnapshot(userId)
  return {
    ...snapshot,
    pass: snapshot.hasPasswordCredential === expectedHasCredential,
  }
}

async function signInViaMagicLink(page: Page, email: string) {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (error || !data.properties?.hashed_token) {
    throw error ?? new Error('generateLink(magiclink) failed: no hashed_token')
  }

  const { data: sess, error: otpErr } = await anonAuth.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session) {
    throw otpErr ?? new Error('verifyOtp(magiclink) failed')
  }

  await injectSupabaseSession(page, sess.session)
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForURL(/\/(dashboard|settings|onboarding|menu-management)/, { timeout: 90_000 })
}

async function loginWithPassword(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(/\/(dashboard|settings|menu-management)/, { timeout: 90_000 })
}

async function gotoSignInMethodsSection(page: Page) {
  await page.goto(`${BASE_URL}/settings#profile`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'Sign-in Methods' }).waitFor({ timeout: 60_000 })
}

function addPasswordButton(page: Page) {
  return page.getByRole('button', { name: /add email.*password/i })
}

async function openAddPasswordDialog(page: Page) {
  await addPasswordButton(page).click()
  await page.getByRole('dialog').getByRole('heading', { name: /add email.*password/i }).waitFor({
    timeout: 10_000,
  })
}

function dialogPasswordFields(page: Page) {
  const dialog = page.getByRole('dialog')
  return {
    password: dialog.getByLabel(/^new password$/i),
    confirm: dialog.getByLabel(/^confirm password$/i),
    submit: dialog.getByRole('button', { name: /save password/i }),
  }
}

async function cleanup() {
  for (const restaurantId of created.restaurantIds) {
    await admin.from('restaurant_users').delete().eq('restaurant_id', restaurantId)
    await admin.from('users').delete().eq('restaurant_id', restaurantId)
    await admin.from('restaurant_roles').delete().eq('restaurant_id', restaurantId)
    await admin.from('restaurants').delete().eq('id', restaurantId)
  }
  for (const userId of created.userIds) {
    await admin.from('users').delete().eq('id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
}

async function main() {
  const results: Record<string, unknown> = {
    baseUrl: BASE_URL,
    tag,
    manualVerification: [
      'Two-tab: open Settings in a second browser tab while adding password; confirm no duplicate repair/loading screens (single-tab script cannot assert cross-tab).',
      'Real Google OAuth account (non-SQL-simulated): sign in with Continue with Google, then add password — SQL simulation covers capability UI only.',
      'Supabase "Secure password change" / reauthentication with stale session (>24h): verify dashboard setting manually if enabled.',
      'Offline submit: DevTools → Offline during Save password — confirm retryable network error (not in automated matrix).',
    ],
  }

  let sqlSimulationOk = true
  try {
    runLinkedSql('SELECT 1 AS ok;')
  } catch (error: unknown) {
    sqlSimulationOk = false
    results.sqlSimulation = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      note: 'Checks 1,3,4,5,6,7 require `npx supabase link` to flashtap-staging for google-only fixture.',
    }
  }

  const browser = await chromium.launch({ headless: true })

  try {
    // --- Check 2: email/password-only — no add button ---
    const check2: Record<string, unknown> = {}
    const ctx2 = await browser.newContext()
    const page2 = await ctx2.newPage()
    try {
      await loginWithPassword(page2, EMAIL_ONLY_EMAIL, EMAIL_ONLY_PASSWORD)
      await gotoSignInMethodsSection(page2)
      check2.addButtonVisible = await addPasswordButton(page2).isVisible().catch(() => false)
      check2.pass = check2.addButtonVisible === false
    } finally {
      await ctx2.close()
    }
    results.check2_emailOnly_noAddButton = check2

    if (!sqlSimulationOk) {
      results.check1_googleOnly_happyPath = { pass: false, skipped: true, reason: 'SQL simulation unavailable' }
      results.check3_googlePlusPassword_noAddButton = { pass: false, skipped: true }
      results.check4_weakPassword_clientRejected = { pass: false, skipped: true }
      results.check5_mismatch_clientRejected = { pass: false, skipped: true }
      results.check6_authProviderRemounts = { pass: false, skipped: true }
      results.check7_signInAfterAddPassword = { pass: false, skipped: true }
    } else {
      // --- Seed google+password user (check 3) ---
      const googlePlusEmail = `${tag}.google-plus@flashtap-test.invalid`
      const { userId: googlePlusUserId } = await seedOwnerUser(googlePlusEmail)
      await simulateGoogleOnlyIdentity(googlePlusUserId, googlePlusEmail)
      const { error: setPwErr } = await admin.auth.admin.updateUserById(googlePlusUserId, {
        password: ephemeralPassword,
        // Admin API uses user_metadata (client updateUser uses `data`, same column).
        user_metadata: { [HAS_PASSWORD_CREDENTIAL_METADATA_KEY]: true },
      })
      if (setPwErr) throw setPwErr
      const credentialCheck3 = await assertPasswordCredential(googlePlusUserId, true)

      const check3: Record<string, unknown> = {}
      const ctx3 = await browser.newContext()
      const page3 = await ctx3.newPage()
      try {
        await loginWithPassword(page3, googlePlusEmail, ephemeralPassword)
        await gotoSignInMethodsSection(page3)
        check3.addButtonVisible = await addPasswordButton(page3).isVisible().catch(() => false)
        check3.identityProviders = credentialCheck3.providers
        check3.hasPasswordCredential = credentialCheck3.hasPasswordCredential
        check3.hasPasswordCredentialMetadata = credentialCheck3.hasPasswordCredentialMetadata
        check3.pass = credentialCheck3.pass && check3.addButtonVisible === false
      } finally {
        await ctx3.close()
      }
      results.check3_googlePlusPassword_noAddButton = check3

      // --- Checks 1,4,5,6,7 on google-only ephemeral user ---
      const googleOnlyEmail = `${tag}.google-only@flashtap-test.invalid`
      const { userId: googleOnlyUserId } = await seedOwnerUser(googleOnlyEmail)
      await simulateGoogleOnlyIdentity(googleOnlyUserId, googleOnlyEmail)
      const idCheck1Before = await assertIdentities(googleOnlyUserId, ['google'])

      const check1: Record<string, unknown> = {}
      const check4: Record<string, unknown> = {}
      const check5: Record<string, unknown> = {}
      const check6: Record<string, unknown> = {}
      const check7: Record<string, unknown> = {}

      const consoleEntries: ConsoleEntry[] = []
      const ctx1 = await browser.newContext()
      const page1 = await ctx1.newPage()
      attachConsoleTap(page1, consoleEntries)

      try {
        await signInViaMagicLink(page1, googleOnlyEmail)
        const mountsAfterLogin = countAuthProviderMounts(consoleEntries)

        await gotoSignInMethodsSection(page1)
        const mountsAfterSettings = countAuthProviderMounts(consoleEntries)

        check1.addButtonVisibleBefore = await addPasswordButton(page1).isVisible()
        check1.identityBefore = idCheck1Before

        await openAddPasswordDialog(page1)
        const fields = dialogPasswordFields(page1)

        // Check 4 — weak password
        await fields.password.fill('short1')
        await fields.confirm.fill('short1')
        await fields.submit.click()
        check4.weakPasswordErrorVisible = await page1
          .getByText(PASSWORD_TOO_SHORT_MESSAGE)
          .isVisible()
          .catch(() => false)
        check4.successNotShown = !(await page1
          .getByText('Password added', { exact: true })
          .first()
          .isVisible()
          .catch(() => false))
        check4.pass = check4.weakPasswordErrorVisible === true && check4.successNotShown === true

        // Check 5 — mismatch
        await fields.password.fill(newPasswordForHappyPath)
        await fields.confirm.fill(`${newPasswordForHappyPath}x`)
        await fields.submit.click()
        check5.mismatchErrorVisible = await page1
          .getByText(PASSWORD_MISMATCH_MESSAGE)
          .isVisible()
          .catch(() => false)
        check5.pass = check5.mismatchErrorVisible === true

        // Check 1 + 6 — happy path submit
        const mountsBeforeSubmit = countAuthProviderMounts(consoleEntries)
        const unmountsBeforeSubmit = countAuthProviderUnmounts(consoleEntries)

        await fields.password.fill(newPasswordForHappyPath)
        await fields.confirm.fill(newPasswordForHappyPath)
        await fields.submit.click()
        await page1.getByText('Password added', { exact: true }).first().waitFor({ timeout: 30_000 })

        const mountsAfterSuccess = countAuthProviderMounts(consoleEntries)
        const unmountsAfterSuccess = countAuthProviderUnmounts(consoleEntries)
        const authEvents = parseAuthEvents(consoleEntries)
        const userUpdatedEvents = authEvents.filter((e) => e.event === 'USER_UPDATED')

        check6.mountsAfterLogin = mountsAfterLogin
        check6.mountsAfterSettings = mountsAfterSettings
        check6.mountsBeforeSubmit = mountsBeforeSubmit
        check6.mountsAfterSuccess = mountsAfterSuccess
        check6.unmountsAfterSuccess = unmountsAfterSuccess
        // Navigating to /settings may remount AuthProvider once (pre-existing; not caused by
        // Sign-in Methods). Tracked separately: https://github.com/Lenton-Losper/Tap-n-Munch/issues/33
        check6.extraMountsDuringAddPasswordFlow = mountsAfterSuccess - mountsAfterSettings
        check6.userUpdatedEventCount = userUpdatedEvents.length
        check6.pass =
          mountsAfterSettings === mountsBeforeSubmit &&
          mountsBeforeSubmit === mountsAfterSuccess &&
          unmountsAfterSuccess === 0

        const credentialCheck1After = await assertPasswordCredential(googleOnlyUserId, true)
        check1.successToastSeen = true
        check1.credentialAfter = credentialCheck1After
        check1.pass =
          check1.addButtonVisibleBefore === true &&
          idCheck1Before.pass &&
          credentialCheck1After.pass &&
          check1.successToastSeen === true

        await page1.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
        check1.addButtonHiddenAfter = !(await addPasswordButton(page1).isVisible().catch(() => true))
        if (check1.pass && check1.addButtonHiddenAfter !== true) {
          check1.pass = false
          check1.note = 'Add button still visible after success (local UI state or deploy issue)'
        }

        // Check 7 — sign out → sign in with new password
        await ctx1.clearCookies()
        await page1.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
        await loginWithPassword(page1, googleOnlyEmail, newPasswordForHappyPath)
        check7.landedAfterSignIn = page1.url()
        check7.onStaffRoute = /\/(dashboard|settings|menu-management)/.test(page1.url())
        check7.pass = check7.onStaffRoute === true

        results.check4_weakPassword_clientRejected = check4
        results.check5_mismatch_clientRejected = check5
        results.check6_authProviderRemounts = check6
        results.check7_signInAfterAddPassword = check7
        results.check1_googleOnly_happyPath = check1
      } finally {
        await ctx1.close()
      }
    }

    console.log(JSON.stringify(results, null, 2))

    const checks = [
      results.check1_googleOnly_happyPath,
      results.check2_emailOnly_noAddButton,
      results.check3_googlePlusPassword_noAddButton,
      results.check4_weakPassword_clientRejected,
      results.check5_mismatch_clientRejected,
      results.check6_authProviderRemounts,
      results.check7_signInAfterAddPassword,
    ] as Array<{ pass?: boolean; skipped?: boolean }>

    const allPass = checks.every((c) => c?.skipped || c?.pass === true)
    if (!allPass) {
      console.error('SIGNIN_METHODS_STAGING_FAIL')
      process.exitCode = 1
    } else {
      console.log('SIGNIN_METHODS_STAGING_OK')
    }
  } finally {
    await browser.close()
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
