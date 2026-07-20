/**
 * Staging (write, self-cleaning, ephemeral user only): verifies the
 * self-service "Change password" feature, which reuses resetPasswordForEmail
 * (the same mechanism as /forgot-password -> /reset-password).
 *
 *   npx tsx scripts/verify-password-change-flow-staging.ts
 *
 * Covers:
 *   1. Whether "Secure password change" gates this reset-link path. GoTrue
 *      only requires a reauthentication nonce for updateUser({ password })
 *      when the session is >24h old — the reset-link flow always produces a
 *      brand-new (seconds-old) session, so by construction it should never
 *      hit that gate regardless of the project's setting. Verified
 *      empirically here (not assumed): drive the actual recovery-link ->
 *      new-session -> updateUser({ password }) path with no nonce and
 *      confirm it succeeds.
 *   2. Full round trip: change password via the reset-link flow, confirm
 *      login works with the new password, confirm the old password no
 *      longer works.
 *
 * Requires:
 *   - .env.test with staging Supabase (mdqjpxwczrhkxkbqatqa)
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const OLD_PASSWORD = requireStagingTestPassword()
const NEW_PASSWORD = `New${Date.now()}!Pw9`

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const anonAuth = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `password-change-${Date.now()}`
const EMAIL = `${tag}@example.com`

async function main() {
  let userId: string | undefined
  try {
    console.log('=== Password-change feature: staging verification ===\n')

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: OLD_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL})\n`)

    // --- Drive the actual reset-link mechanism the "Change password" button uses ---
    console.log('--- Requesting recovery link (same mechanism as resetPasswordForEmail) ---')
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: EMAIL,
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
      throw linkErr ?? new Error('generateLink(recovery) failed: no hashed_token')
    }

    const { data: verifyData, error: verifyErr } = await anonAuth.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'recovery',
    })
    if (verifyErr || !verifyData.session) {
      throw verifyErr ?? new Error('verifyOtp(recovery) failed: no session')
    }
    console.log('Recovery link verified — brand-new session established (seconds old).\n')

    // --- The actual change, no nonce supplied, on this brand-new session ---
    console.log('--- Calling updateUser({ password }) on the fresh recovery session, no nonce ---')
    const { error: updateErr } = await anonAuth.auth.updateUser({ password: NEW_PASSWORD })
    if (updateErr) {
      const msg = (updateErr.message || '').toLowerCase()
      const looksLikeSecureChangeGate =
        msg.includes('nonce') || msg.includes('reauthenticat') || msg.includes('reauth')
      console.log(`  FAILED: ${updateErr.message}`)
      if (looksLikeSecureChangeGate) {
        console.log('  This looks like the Secure Password Change gate — UNEXPECTED for a seconds-old session.')
      }
      throw updateErr
    }
    console.log('  OK — password changed with no nonce, confirming the reset-link path sidesteps')
    console.log('  Secure Password Change entirely (that setting only gates sessions >24h old).\n')

    // --- Full round trip: new password works, old password doesn't ---
    console.log('--- Verifying new password works ---')
    const { error: newLoginErr } = await anonAuth.auth.signOut()
    if (newLoginErr) console.warn('  signOut warning (non-fatal):', newLoginErr.message)

    const { data: newLogin, error: newLoginErr2 } = await anonAuth.auth.signInWithPassword({
      email: EMAIL,
      password: NEW_PASSWORD,
    })
    const newPasswordWorks = !newLoginErr2 && Boolean(newLogin.session)
    console.log(`  Sign-in with NEW password: ${newPasswordWorks ? 'OK' : `FAILED (${newLoginErr2?.message})`}`)
    if (!newPasswordWorks) throw new Error('New password does not work — round trip failed')

    await anonAuth.auth.signOut().catch(() => {})

    console.log('--- Verifying old password no longer works ---')
    const { data: oldLogin, error: oldLoginErr } = await anonAuth.auth.signInWithPassword({
      email: EMAIL,
      password: OLD_PASSWORD,
    })
    const oldPasswordRejected = Boolean(oldLoginErr) && !oldLogin.session
    console.log(`  Sign-in with OLD password: ${oldPasswordRejected ? `correctly rejected (${oldLoginErr?.message})` : 'UNEXPECTEDLY SUCCEEDED'}`)
    if (!oldPasswordRejected) throw new Error('Old password still works — it should have been invalidated')

    console.log('\n=== ALL CHECKS PASSED ===')
  } catch (e) {
    console.error('\n=== FAILED ===')
    console.error(e)
    throw e
  } finally {
    if (userId) {
      try {
        await admin.auth.admin.deleteUser(userId)
      } catch (e) {
        console.error('cleanup deleteUser failed:', e)
      }
      console.log(`\nCleaned up ephemeral user ${userId}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
