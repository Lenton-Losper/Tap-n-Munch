/**
 * Staging (write, self-cleaning): does the REAL user-facing mechanism (HTTP
 * GET on the action_link, following redirects -- exactly what a browser
 * does when a user clicks the email link) work for email_change_new, even
 * though the SDK's verifyOtp({type:'email_change'}) consistently failed
 * with "invalid or expired"? Real users never call verifyOtp directly --
 * only this HTTP path -- so this determines whether that SDK quirk is a
 * testing-tool artifact or a real user-facing bug.
 *
 *   npx tsx scripts/investigate-email-change-real-http-click-staging.ts
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

const tag = `real-click-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

async function followLink(actionLink: string) {
  let url = actionLink
  const hops: string[] = []
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { redirect: 'manual' })
    hops.push(`${res.status} ${url}`)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return { status: res.status, hops, finalUrl: url, body: '' }
      url = new URL(location, url).toString()
      continue
    }
    const body = await res.text().catch(() => '')
    return { status: res.status, hops, finalUrl: url, body }
  }
  return { status: 0, hops, finalUrl: url, body: '' }
}

async function main() {
  let userId: string | undefined
  try {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL})\n`)

    // Known-allowlisted redirectTo per earlier differential test.
    const redirectTo = `${BASE_URL}/reset-password`
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: EMAIL,
      newEmail: NEW_EMAIL,
      options: { redirectTo },
    })
    if (linkErr || !linkData?.properties?.action_link) {
      throw linkErr ?? new Error('generateLink failed: no action_link')
    }

    console.log('--- Following the real action_link via HTTP GET (what a browser click does) ---')
    const result = await followLink(linkData.properties.action_link)
    console.log(`Final status: ${result.status}`)
    console.log(`Final URL: ${result.finalUrl}`)
    console.log(`Redirect chain:\n  ${result.hops.join('\n  ')}`)

    const { data: after } = await admin.auth.admin.getUserById(userId)
    console.log(`\nauth.users.email after the click: ${after.user?.email}`)
    console.log(`Email actually changed: ${after.user?.email?.toLowerCase() === NEW_EMAIL.toLowerCase()}`)
    console.log(`\nConclusion: the real HTTP link-click mechanism ${result.status === 200 && after.user?.email?.toLowerCase() === NEW_EMAIL.toLowerCase() ? 'WORKS -- verifyOtp SDK failure is a testing-tool artifact, not a real-user bug.' : 'ALSO fails -- this is a real issue, not just an SDK-testing artifact.'}`)
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
