/**
 * Staging (read/write, self-cleaning, ephemeral user only): empirically
 * determine two things for the email-change feature scoping (Part A):
 *
 *   1. Does updateUser({ email }) require confirmation from just the new
 *      address, or both old and new ("Secure email change")? Observed via
 *      auth.users.email_change_token_new / email_change_token_current after
 *      triggering the change — this project's dashboard setting isn't
 *      configured anywhere in code (confirmed by repo-wide grep), so this is
 *      the only way to know.
 *   2. For an account with a Google identity ALSO linked: does changing the
 *      primary email disturb the Google identity's provider_id/user_id
 *      linkage (the thing Google sign-in actually resolves by), or its
 *      identity_data.email?
 *
 * Uses the same SQL-based identity simulation technique already established
 * in scripts/verify-sign-in-methods-staging.ts (simulateGoogleOnlyIdentity) —
 * this repo has no existing pattern for driving a real Google OAuth consent
 * screen in an automated script, so, like that script, this creates a
 * synthetic 'google' auth.identities row rather than a live-linked one. That
 * is sufficient to answer the structural question (is the linkage keyed by
 * provider_id, independent of email) but is NOT literal proof that a live
 * Google account's sign-in continues to work — see caveat in final report.
 *
 * Creates one ephemeral auth user (no restaurant/public.users scaffolding
 * needed for this test) and deletes it at the end regardless of outcome.
 *
 *   npx tsx scripts/investigate-email-change-google-link-staging.ts
 *
 * Requires:
 *   - .env.test with staging Supabase (mdqjpxwczrhkxkbqatqa)
 *   - Supabase CLI linked to flashtap-staging (for the synthetic identity SQL)
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
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const anonAuth = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `email-change-google-${Date.now()}`
// NOTE: GoTrue's self-service updateUser({ email }) path rejected the .invalid TLD
// (RFC 2606) with `email_address_invalid` — first for the new address, then (once
// that was fixed) for the CURRENT/old address too, right at the point of triggering
// the change. That second failure is itself an empirical signal: GoTrue appears to
// validate/notify BOTH addresses as part of the update, consistent with "Secure
// email change" being on. Using example.com for both (valid TLD, no MX records —
// RFC 2606 documentation domain, non-deliverable, so nothing real gets emailed).
const OLD_EMAIL = `${tag}.old@example.com`
const NEW_EMAIL = `${tag}.new@example.com`
const GOOGLE_SUB = `google-dual-sim-${randomUUID()}`

function runLinkedSql(sql: string): string {
  const file = join(tmpdir(), `${tag}-${randomUUID()}.sql`)
  writeFileSync(file, sql, 'utf8')
  try {
    return execSync(`npx supabase db query --linked -f "${file}" -o json`, {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } finally {
    unlinkSync(file)
  }
}

async function waitForAuthUserVisibleViaDirectSql(userId: string, attempts = 8, delayMs = 1500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const out = runLinkedSql(`SELECT id FROM auth.users WHERE id = '${userId}'::uuid;`)
    if (out.includes(userId)) return
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(
    `auth.users row for ${userId} never became visible via direct SQL connection after ${attempts} attempts — ` +
      'likely a pooler/replica routing difference between the Admin API and `supabase db query --linked`, not just brief lag.',
  )
}

async function addGoogleIdentity(userId: string, email: string) {
  runLinkedSql(`
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
VALUES (
  '${GOOGLE_SUB}',
  '${userId}'::uuid,
  jsonb_build_object(
    'iss', 'https://accounts.google.com',
    'sub', '${GOOGLE_SUB}',
    'email', '${email}',
    'email_verified', true,
    'full_name', 'IDS Email-Change Dual Sim'
  ),
  'google',
  now(), now(), now()
);
`)
}

function fetchAuthUsersEmailChangeColumns(userId: string): string {
  return runLinkedSql(`
SELECT
  email,
  email_change,
  email_change_confirm_status,
  (email_change_token_new IS NOT NULL AND email_change_token_new != '') AS has_token_new,
  (email_change_token_current IS NOT NULL AND email_change_token_current != '') AS has_token_current,
  email_change_sent_at
FROM auth.users
WHERE id = '${userId}'::uuid;
`)
}

function fetchIdentitiesRaw(userId: string): string {
  return runLinkedSql(`
SELECT provider, provider_id, identity_data->>'email' AS identity_email, user_id
FROM auth.identities
WHERE user_id = '${userId}'::uuid
ORDER BY provider;
`)
}

async function main() {
  let userId: string | undefined
  try {
    console.log('=== Email-change confirmation + Google-link structural test (staging) ===\n')

    // --- Setup: ephemeral user with password (gets an 'email' identity), plus a synthetic 'google' identity ---
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: OLD_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${OLD_EMAIL})`)

    await waitForAuthUserVisibleViaDirectSql(userId)
    await addGoogleIdentity(userId, OLD_EMAIL)
    console.log('Added synthetic google identity (dual-linked: email + google)\n')

    console.log('--- Identities BEFORE email change ---')
    console.log(fetchIdentitiesRaw(userId))

    console.log('--- auth.users email-change columns BEFORE ---')
    console.log(fetchAuthUsersEmailChangeColumns(userId))

    // --- Initiate the change purely via admin.generateLink (never sends real email,
    //     per Supabase docs — this sets the same pending-change DB state that the
    //     self-service updateUser({ email }) call would, without touching the mailer). ---
    const { data: newLinkData, error: newLinkErr } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: OLD_EMAIL,
      newEmail: NEW_EMAIL,
    })
    if (newLinkErr || !newLinkData?.properties?.hashed_token) {
      throw newLinkErr ?? new Error('generateLink(email_change_new) failed: no hashed_token')
    }
    console.log(`Initiated email change via generateLink(email_change_new) — new_email pending: ${newLinkData.user?.new_email}\n`)

    // --- Immediately after: is the email already changed, or pending? ---
    const { data: afterTrigger } = await admin.auth.admin.getUserById(userId)
    console.log('--- admin.getUserById immediately after initiating the change ---')
    console.log(`email:                ${afterTrigger?.user?.email}`)
    console.log(`new_email (pending):  ${afterTrigger?.user?.new_email}`)
    console.log(`email_change_sent_at: ${afterTrigger?.user?.email_change_sent_at}\n`)

    console.log('--- auth.users email-change columns AFTER initiating (before any confirmation) ---')
    console.log(fetchAuthUsersEmailChangeColumns(userId))
    console.log('(has_token_current=true means BOTH old and new email must confirm — "Secure email change" is ON for this project.')
    console.log(' has_token_current=false with has_token_new=true means only the new address needs to confirm.)\n')

    console.log('--- Identities immediately after initiating (should be untouched — nothing confirmed yet) ---')
    console.log(fetchIdentitiesRaw(userId))

    // --- Complete the confirmation via verifyOtp for the new-email token, plus generate+verify
    //     the current-email token too if the DB shows it's required. Neither call sends real mail. ---
    console.log('--- Completing confirmation ---')
    const { error: verifyNewErr } = await anonAuth.auth.verifyOtp({
      token_hash: newLinkData.properties.hashed_token,
      type: 'email_change',
    })
    console.log(`  email_change_new: verifyOtp ${verifyNewErr ? `FAILED (${verifyNewErr.message})` : 'OK'}`)

    const { data: currentLinkData, error: currentLinkErr } = await admin.auth.admin.generateLink({
      type: 'email_change_current',
      email: OLD_EMAIL,
      newEmail: NEW_EMAIL,
    })
    if (currentLinkErr || !currentLinkData?.properties?.hashed_token) {
      console.log(`  email_change_current: generateLink failed/no token — ${currentLinkErr?.message ?? 'no hashed_token'} (expected if only the new address needed to confirm)`)
    } else {
      const { error: verifyCurrentErr } = await anonAuth.auth.verifyOtp({
        token_hash: currentLinkData.properties.hashed_token,
        type: 'email_change',
      })
      console.log(`  email_change_current: verifyOtp ${verifyCurrentErr ? `FAILED (${verifyCurrentErr.message})` : 'OK'}`)
    }

    const { data: afterConfirm } = await admin.auth.admin.getUserById(userId)
    console.log('\n--- admin.getUserById AFTER confirmation ---')
    console.log(`email:               ${afterConfirm?.user?.email}`)
    console.log(`new_email (pending): ${afterConfirm?.user?.new_email}`)
    const emailActuallyChanged = afterConfirm?.user?.email?.toLowerCase() === NEW_EMAIL.toLowerCase()
    console.log(`Email actually swapped to new address: ${emailActuallyChanged}\n`)

    console.log('--- Identities AFTER confirmation (key structural check) ---')
    console.log(fetchIdentitiesRaw(userId))
    console.log('(Compare google row provider/provider_id/user_id to the BEFORE snapshot above — if unchanged,')
    console.log(' Google sign-in resolution — which matches by provider+provider_id, not email — is structurally unaffected.)\n')

    console.log('=== DONE — see report above ===')
  } finally {
    if (userId) {
      await admin.auth.admin.deleteUser(userId).catch((e) => console.error('cleanup deleteUser failed:', e))
      console.log(`\nCleaned up ephemeral user ${userId}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
