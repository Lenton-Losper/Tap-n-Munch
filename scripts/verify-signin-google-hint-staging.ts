/**
 * Staging verification for the sign-in "signed up with Google" hint fix (#34).
 *
 * Confirms should_show_google_signin_hint (migration 20260714120000) returns:
 *   1. true  — account has a google identity and no email identity/password metadata
 *   2. false — account has both google + password (this is the exact bug #34 reports:
 *              the old code showed the hint here on any wrong-password attempt)
 *   3. false — account has only a password credential
 *   4. false — email doesn't match any account
 *
 *   npx tsx scripts/verify-signin-google-hint-staging.ts
 *
 * Requires:
 *   - migration 20260714120000_signin_google_hint_check on staging
 *   - Supabase CLI linked to staging (mdqjpxwczrhkxkbqatqa) for identity simulation SQL,
 *     run only through the mandatory guard (scripts/safe-supabase-linked.ts) — see
 *     CONTRIBUTING.md.
 */
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const STAGING_TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

/** Runs SQL against staging only through the mandatory safe-supabase-linked guard. */
function runSafeLinkedSql(sql: string): void {
  const file = join(tmpdir(), `signin-hint-verify-${randomUUID()}.sql`)
  writeFileSync(file, sql, 'utf8')
  try {
    execSync(`npx tsx scripts/safe-supabase-linked.ts ${STAGING_REF} db query --linked -f "${file}"`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } finally {
    unlinkSync(file)
  }
}

/** Converts the user's existing 'email' identity into a lone 'google' identity, no password. */
function convertToGoogleOnlyIdentity(userId: string, email: string): void {
  runSafeLinkedSql(`
UPDATE auth.identities
SET
  provider = 'google',
  provider_id = '${userId}',
  identity_data = jsonb_build_object(
    'iss', 'https://accounts.google.com',
    'sub', '${userId}',
    'email', '${email}',
    'email_verified', true
  ),
  updated_at = now()
WHERE user_id = '${userId}'::uuid AND provider = 'email';

UPDATE auth.users
SET encrypted_password = NULL, updated_at = now()
WHERE id = '${userId}'::uuid;
`)
}

/** Adds a second 'google' identity alongside the existing 'email' identity + password. */
function addLinkedGoogleIdentity(userId: string, email: string): void {
  runSafeLinkedSql(`
INSERT INTO auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
VALUES (
  '${userId}',
  '${userId}'::uuid,
  jsonb_build_object(
    'iss', 'https://accounts.google.com',
    'sub', '${userId}',
    'email', '${email}',
    'email_verified', true
  ),
  'google',
  now(),
  now(),
  now()
);
`)
}

async function checkHint(email: string): Promise<boolean> {
  const { data, error } = await admin.rpc('should_show_google_signin_hint', { p_email: email })
  if (error) throw error
  return data === true
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  const createdUserIds: string[] = []

  console.log(`[${ts()}] === Sign-in Google hint staging verification (#34) ===`)

  try {
    // Case 1: Google-only account (no password, no 'email' identity).
    const googleOnlyEmail = `hint-google-only-${tag}@example.com`
    const { data: googleOnlyUser, error: googleOnlyError } = await admin.auth.admin.createUser({
      email: googleOnlyEmail,
      password: STAGING_TEST_PASSWORD,
      email_confirm: true,
    })
    if (googleOnlyError || !googleOnlyUser.user?.id) throw googleOnlyError
    createdUserIds.push(googleOnlyUser.user.id)
    convertToGoogleOnlyIdentity(googleOnlyUser.user.id, googleOnlyEmail)

    await assert(
      (await checkHint(googleOnlyEmail)) === true,
      'Google-only account (no password identity): hint = true',
    )

    // Case 2: Google + password (both identities) - must NOT show hint.
    // This is the exact scenario #34 reports as broken (flashtaptestacc1@gmail.com).
    const bothEmail = `hint-both-${tag}@example.com`
    const { data: bothUser, error: bothError } = await admin.auth.admin.createUser({
      email: bothEmail,
      password: STAGING_TEST_PASSWORD,
      email_confirm: true,
    })
    if (bothError || !bothUser.user?.id) throw bothError
    createdUserIds.push(bothUser.user.id)
    addLinkedGoogleIdentity(bothUser.user.id, bothEmail)

    await assert(
      (await checkHint(bothEmail)) === false,
      'Google + password account: hint = false (this is the exact bug #34 reports)',
    )

    // Case 3: password-only account - must NOT show hint.
    const passwordOnlyEmail = `hint-password-only-${tag}@example.com`
    const { data: passwordOnlyUser, error: passwordOnlyError } = await admin.auth.admin.createUser({
      email: passwordOnlyEmail,
      password: STAGING_TEST_PASSWORD,
      email_confirm: true,
    })
    if (passwordOnlyError || !passwordOnlyUser.user?.id) throw passwordOnlyError
    createdUserIds.push(passwordOnlyUser.user.id)

    await assert(
      (await checkHint(passwordOnlyEmail)) === false,
      'password-only account: hint = false',
    )

    // Case 4: unknown email - must NOT show hint (no account-existence oracle beyond this).
    await assert(
      (await checkHint(`hint-nonexistent-${tag}@example.com`)) === false,
      'nonexistent email: hint = false',
    )

    console.log(`\n[${ts()}] Sign-in Google hint verification passed.`)
  } finally {
    for (const userId of createdUserIds) {
      await admin.from('users').delete().eq('id', userId)
      await admin.auth.admin.deleteUser(userId).catch(() => {})
    }
    console.log(`[${ts()}] cleanup complete (${createdUserIds.length} test users)`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
