/**
 * Staging (write, self-cleaning): differential test to isolate WHY
 * generateLink(type: 'email_change_new') silently substituted redirect_to
 * with http://localhost:3000 instead of our requested URL, while
 * generateLink(type: 'recovery') with the same base URL pattern honored it.
 *
 * Tests two swapped combinations:
 *   A. type='recovery',      redirectTo=.../auth/callback?type=email_change
 *      (same path email_change uses, but under the type that worked)
 *   B. type='email_change_new', redirectTo=.../reset-password
 *      (same path recovery uses, but under the type that failed)
 *
 * If (A) still gets substituted -> the /auth/callback path/pattern itself
 * isn't allowlisted (path-based issue, independent of link type).
 * If (A) is honored but (B) is still substituted -> it's specific to the
 * email_change link type not respecting redirectTo at all (type-based).
 *
 *   npx tsx scripts/investigate-link-redirect-differential-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  process.env.FLASHTAP_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')
const TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `redir-diff-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

function extractRedirectTo(actionLink: string): string {
  return new URL(actionLink).searchParams.get('redirect_to') || '(none)'
}

async function main() {
  let userId: string | undefined
  try {
    console.log('=== Differential redirect_to test (staging) ===\n')

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL})\n`)

    // A: recovery type, pointed at the /auth/callback path email_change uses
    const pathA = `${BASE_URL}/auth/callback?type=email_change`
    const { data: linkA, error: errA } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: EMAIL,
      options: { redirectTo: pathA },
    })
    if (errA || !linkA?.properties?.action_link) {
      console.log('A: generateLink failed:', errA?.message)
    } else {
      const got = extractRedirectTo(linkA.properties.action_link)
      console.log(`A. type=recovery, requested redirectTo=${pathA}`)
      console.log(`   actual redirect_to in link: ${got}`)
      console.log(`   honored: ${got === pathA}\n`)
    }

    // B: email_change_new type, pointed at the /reset-password path recovery uses
    const pathB = `${BASE_URL}/reset-password`
    const { data: linkB, error: errB } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: EMAIL,
      newEmail: NEW_EMAIL,
      options: { redirectTo: pathB },
    })
    if (errB || !linkB?.properties?.action_link) {
      console.log('B: generateLink failed:', errB?.message)
    } else {
      const got = extractRedirectTo(linkB.properties.action_link)
      console.log(`B. type=email_change_new, requested redirectTo=${pathB}`)
      console.log(`   actual redirect_to in link: ${got}`)
      console.log(`   honored: ${got === pathB}\n`)
    }

    // C, for completeness: email_change_new with NO redirectTo option at all
    const { data: linkC, error: errC } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: EMAIL,
      newEmail: NEW_EMAIL,
    })
    if (errC || !linkC?.properties?.action_link) {
      console.log('C: generateLink failed:', errC?.message)
    } else {
      console.log(`C. type=email_change_new, NO redirectTo passed at all`)
      console.log(`   actual redirect_to in link: ${extractRedirectTo(linkC.properties.action_link)}\n`)
    }

    console.log('=== DONE ===')
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
