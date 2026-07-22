/**
 * Staging (write, self-cleaning): does the verifyOtp "invalid or expired"
 * failure for email_change_new correlate with the redirect_to being
 * substituted to the (unreachable, dev-default) Site URL, or does it fail
 * even when redirectTo resolves to a known-allowlisted path?
 *
 *   npx tsx scripts/investigate-verifyotp-redirect-correlation-staging.ts
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
const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  process.env.FLASHTAP_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')
const TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
const anonAuth = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `verifyotp-corr-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

async function main() {
  let userId: string | undefined
  try {
    console.log('=== verifyOtp / redirect_to correlation test (staging) ===\n')

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL})\n`)

    // Known-allowlisted redirectTo (per the differential test: /reset-password is honored for email_change_new)
    const allowlistedRedirect = `${BASE_URL}/reset-password`
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: EMAIL,
      newEmail: NEW_EMAIL,
      options: { redirectTo: allowlistedRedirect },
    })
    if (linkErr || !linkData?.properties?.hashed_token) {
      throw linkErr ?? new Error('generateLink failed: no hashed_token')
    }
    console.log(`generateLink redirect_to actually used: ${new URL(linkData.properties.action_link).searchParams.get('redirect_to')}`)

    const { error: verifyErr } = await anonAuth.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'email_change',
    })
    if (verifyErr) {
      console.log(`\nverifyOtp with ALLOWLISTED redirectTo: FAILED (${verifyErr.message})`)
      console.log('-> The verifyOtp failure is NOT correlated with the redirect_to substitution;')
      console.log('   it fails even when redirect_to resolves to a known-good, allowlisted path.')
    } else {
      console.log('\nverifyOtp with ALLOWLISTED redirectTo: OK')
      console.log('-> The verifyOtp failure IS correlated with the redirect_to substitution --')
      console.log('   using an allowlisted redirect fixed it.')
      const { data: after } = await admin.auth.admin.getUserById(userId)
      console.log(`   auth.users.email is now: ${after.user?.email}`)
    }

    console.log('\n=== DONE ===')
  } catch (e) {
    console.error('\n=== FAILED ===', e)
  } finally {
    if (userId) {
      try {
        await admin.auth.admin.deleteUser(userId)
      } catch (e) {
        console.error('cleanup deleteUser failed:', e)
      }
      console.log(`Cleaned up ephemeral user ${userId}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
