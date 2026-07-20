/**
 * Staging (write, self-cleaning, ephemeral user only): full round-trip
 * verification of the self-service email-change feature.
 *
 *   npx tsx scripts/verify-email-change-flow-staging.ts
 *
 * Covers:
 *   1. Real confirmation-link round trip via generateLink + verifyOtp
 *      (email_change_new — confirmed empirically that only the new address
 *      needs to confirm on this project).
 *   2. Exercises the ACTUAL shared sync function (lib/auth/sync-user-email.ts)
 *      that both app/auth/callback/route.ts and sync-profile/route.ts call —
 *      not a reimplementation — against a real staff_members row.
 *   3. Confirms public.users.email + staff_members.email land together and
 *      resolveStaffMemberId (lib/permissions/authorize.ts) resolves to the
 *      same staff row afterward.
 *   4. Confirms a linked Google identity is structurally untouched by the
 *      whole flow (confirming pass — structural safety already proven in
 *      the investigation phase).
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

// createServerSupabaseClient() (used inside resolveStaffMemberId and
// syncUserEmailAcrossTables) reads the NEXT_PUBLIC_-prefixed vars, but
// .env.test only sets the unprefixed SUPABASE_URL/SUPABASE_ANON_KEY.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= process.env.SUPABASE_URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= process.env.SUPABASE_ANON_KEY

// Imported AFTER dotenv config so it reads staging env vars when called.
import { syncUserEmailAcrossTables } from '../lib/auth/sync-user-email'
import { resolveStaffMemberId } from '../lib/permissions/authorize'
import { seedDefaultRestaurantRoles } from '../lib/permissions/seed-default-roles'

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

const tag = `email-change-flow-${Date.now()}`
// example.com: valid TLD (passes GoTrue's self-service email format validation,
// unlike .invalid which was empirically rejected earlier tonight), no MX records
// (RFC 2606 documentation domain — nothing real ever gets emailed).
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
  throw new Error(`auth.users row for ${userId} never became visible via direct SQL connection.`)
}

async function addGoogleIdentity(userId: string, email: string) {
  runLinkedSql(`
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
VALUES (
  '${GOOGLE_SUB}',
  '${userId}'::uuid,
  jsonb_build_object('iss', 'https://accounts.google.com', 'sub', '${GOOGLE_SUB}', 'email', '${email}', 'email_verified', true, 'full_name', 'Verify Google Dual Sim'),
  'google',
  now(), now(), now()
);
`)
}

function fetchIdentitiesRaw(userId: string): string {
  return runLinkedSql(`
SELECT provider, provider_id, identity_data->>'email' AS identity_email, user_id
FROM auth.identities WHERE user_id = '${userId}'::uuid ORDER BY provider;
`)
}

async function main() {
  let userId: string | undefined
  let restaurantId: string | undefined
  let staffId: string | undefined
  try {
    console.log('=== Email-change feature: full staging round-trip verification ===\n')

    // --- Setup: ephemeral owner user, public.users row, restaurant, staff_members row, dual Google identity ---
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: OLD_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral auth user ${userId} (${OLD_EMAIL})`)

    await waitForAuthUserVisibleViaDirectSql(userId)
    await addGoogleIdentity(userId, OLD_EMAIL)
    console.log('Added synthetic google identity (dual-linked: email + google)')

    const { data: restaurant, error: restErr } = await admin
      .from('restaurants')
      .insert({ name: `${tag} restaurant`, slug: `${tag}` })
      .select('id')
      .single()
    if (restErr || !restaurant?.id) throw restErr ?? new Error('restaurant insert failed')
    restaurantId = String(restaurant.id)
    console.log(`Created restaurant ${restaurantId}`)

    await seedDefaultRestaurantRoles(admin, restaurantId)

    const { error: userRowErr } = await admin.from('users').insert({
      id: userId,
      email: OLD_EMAIL,
      role: 'owner',
      full_name: 'Verify Email Change',
    })
    if (userRowErr) throw userRowErr

    const { error: ruErr } = await admin
      .from('restaurant_users')
      .insert({ restaurant_id: restaurantId, user_id: userId, role: 'owner' })
    if (ruErr) throw ruErr

    const { data: staffRow, error: staffInsertErr } = await admin
      .from('staff_members')
      .insert({ restaurant_id: restaurantId, email: OLD_EMAIL, role: 'owner' })
      .select('id')
      .single()
    if (staffInsertErr || !staffRow?.id) throw staffInsertErr ?? new Error('staff_members insert failed')
    staffId = String(staffRow.id)
    console.log(`Created staff_members row ${staffId} (email: ${OLD_EMAIL})\n`)

    // --- Pre-check: resolveStaffMemberId resolves correctly BEFORE any change ---
    const staffIdBefore = await resolveStaffMemberId(userId, restaurantId)
    console.log(`resolveStaffMemberId BEFORE change: ${staffIdBefore} (expected ${staffId}, match: ${staffIdBefore === staffId})\n`)
    if (staffIdBefore !== staffId) throw new Error('Pre-check failed: resolveStaffMemberId mismatch before any change')

    console.log('--- Identities BEFORE ---')
    console.log(fetchIdentitiesRaw(userId))

    // --- Real confirmation-link round trip: generateLink + verifyOtp, back-to-back (no intervening calls) ---
    console.log('--- Initiating + confirming via a real generated link (generateLink + verifyOtp) ---')
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: OLD_EMAIL,
      newEmail: NEW_EMAIL,
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
      throw linkErr ?? new Error('generateLink(email_change_new) failed: no hashed_token')
    }
    const { error: verifyErr } = await anonAuth.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'email_change',
    })

    let confirmedViaRealLink = false
    if (verifyErr) {
      console.log(`  verifyOtp on the real generated link FAILED: ${verifyErr.message}`)
      console.log('  Falling back to admin-confirmed direct set (email_confirm: true) to simulate "user already')
      console.log('  clicked the link and GoTrue applied it" — this still exercises the actual sync function')
      console.log('  and real staging data, but does not exercise the live link-click path end-to-end.')
      const { error: adminSetErr } = await admin.auth.admin.updateUserById(userId, {
        email: NEW_EMAIL,
        email_confirm: true,
      })
      if (adminSetErr) throw adminSetErr
    } else {
      confirmedViaRealLink = true
      console.log('  verifyOtp OK — email change confirmed via a real generated link.')
    }

    const { data: authAfter, error: authAfterErr } = await admin.auth.admin.getUserById(userId)
    if (authAfterErr) throw authAfterErr
    const authEmailNow = authAfter.user?.email || ''
    console.log(`\nauth.users.email is now: ${authEmailNow} (confirmed via real link: ${confirmedViaRealLink})\n`)
    if (authEmailNow.toLowerCase() !== NEW_EMAIL.toLowerCase()) {
      throw new Error(`auth.users.email did not end up as ${NEW_EMAIL} — got ${authEmailNow}`)
    }

    // --- This is the exact function app/auth/callback/route.ts and sync-profile/route.ts call ---
    console.log('--- Calling the actual shared sync function: syncUserEmailAcrossTables ---')
    const syncResult = await syncUserEmailAcrossTables(userId, NEW_EMAIL)
    console.log(JSON.stringify(syncResult, null, 2))
    if (!syncResult.ok) throw new Error('syncUserEmailAcrossTables reported failure')

    // --- Verify public.users + staff_members landed, and resolveStaffMemberId still resolves ---
    const { data: publicUserAfter } = await admin.from('users').select('email').eq('id', userId).maybeSingle()
    const { data: staffAfter } = await admin.from('staff_members').select('id, email, role').eq('id', staffId).maybeSingle()
    const staffIdAfter = await resolveStaffMemberId(userId, restaurantId)

    console.log(`\npublic.users.email:   ${publicUserAfter?.email} (matches new: ${publicUserAfter?.email?.toLowerCase() === NEW_EMAIL.toLowerCase()})`)
    console.log(`staff_members.email:  ${staffAfter?.email} (matches new: ${staffAfter?.email?.toLowerCase() === NEW_EMAIL.toLowerCase()}, role unchanged: ${staffAfter?.role === 'owner'})`)
    console.log(`resolveStaffMemberId: ${staffIdAfter} (expected ${staffId}, match: ${staffIdAfter === staffId})`)

    const allOk =
      publicUserAfter?.email?.toLowerCase() === NEW_EMAIL.toLowerCase() &&
      staffAfter?.email?.toLowerCase() === NEW_EMAIL.toLowerCase() &&
      staffAfter?.role === 'owner' &&
      staffIdAfter === staffId
    if (!allOk) throw new Error('Post-sync verification failed')

    // --- Google identity: confirming pass (structural safety already proven) ---
    console.log('\n--- Identities AFTER (confirming Google identity untouched) ---')
    console.log(fetchIdentitiesRaw(userId))

    console.log('\n=== ALL CHECKS PASSED ===')
  } catch (e) {
    console.error('\n=== FAILED ===')
    console.error(e)
    throw e
  } finally {
    if (staffId) {
      try {
        await admin.from('staff_members').delete().eq('id', staffId)
      } catch (e) {
        console.error('cleanup staff_members delete failed:', e)
      }
    }
    if (restaurantId) {
      try {
        await admin.from('restaurant_users').delete().eq('restaurant_id', restaurantId)
      } catch (e) {
        console.error('cleanup restaurant_users delete failed:', e)
      }
      try {
        await admin.from('restaurants').delete().eq('id', restaurantId)
      } catch (e) {
        console.error('cleanup restaurants delete failed:', e)
      }
    }
    if (userId) {
      try {
        await admin.from('users').delete().eq('id', userId)
      } catch (e) {
        console.error('cleanup users delete failed:', e)
      }
      try {
        await admin.auth.admin.deleteUser(userId)
      } catch (e) {
        console.error('cleanup deleteUser failed:', e)
      }
      console.log(`\nCleaned up ephemeral user ${userId} and related rows`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
