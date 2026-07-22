/**
 * Staging (write, self-cleaning, ephemeral user only): empirically determine
 * where a REAL generated link (email_change_new and recovery) actually
 * redirects to when followed via plain HTTP — the same mechanism a user's
 * browser uses when clicking the email link. This exercises GoTrue's
 * `/auth/v1/verify` redirect endpoint directly (unlike verifyOtp, which is a
 * separate SDK call that bypasses the redirect entirely) -- so it can reveal
 * both (a) whether the redirect_to URL allowlist is causing a fallback to
 * the Site URL / landing page, and (b) whether the resulting page is the
 * one we expect (/reset-password, /auth/callback) or something else.
 *
 *   npx tsx scripts/investigate-link-redirect-staging.ts
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

const tag = `link-redirect-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

async function followLink(actionLink: string, label: string) {
  console.log(`\n--- Following action_link for ${label} ---`)
  console.log(`URL: ${actionLink}`)

  let url = actionLink
  const hops: string[] = []
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { redirect: 'manual' })
    hops.push(`${res.status} ${url}`)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        console.log(`  Hop ${i}: ${res.status}, no Location header. Stopping.`)
        break
      }
      url = new URL(location, url).toString()
      continue
    }
    // Final response (not a redirect)
    const bodyText = await res.text().catch(() => '')
    console.log(`  Final: ${res.status} ${url}`)
    console.log(`  Redirect chain:\n    ${hops.join('\n    ')}`)
    const looksLikeLanding = /flashtap.*(landing|marketing)|<title>\s*FlashTap\s*<\/title>/i.test(bodyText) && !url.includes('/reset-password') && !url.includes('/settings') && !url.includes('/auth/callback')
    const finalPath = new URL(url).pathname
    console.log(`  Final path: ${finalPath}`)
    console.log(`  Body snippet (first 300 chars): ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
    return { finalUrl: url, finalPath, status: res.status, looksLikeLanding }
  }
  console.log(`  Redirect chain (did not terminate in 6 hops):\n    ${hops.join('\n    ')}`)
  return { finalUrl: url, finalPath: new URL(url).pathname, status: 0, looksLikeLanding: false }
}

async function main() {
  let userId: string | undefined
  try {
    console.log('=== Real-link redirect investigation (staging) ===')
    console.log(`BASE_URL: ${BASE_URL}\n`)

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL})`)

    // --- recovery, with the exact redirectTo our /forgot-password page sets ---
    const recoveryRedirectTo = `${BASE_URL}/reset-password`
    const { data: recoveryLink, error: recoveryErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: EMAIL,
      options: { redirectTo: recoveryRedirectTo },
    })
    if (recoveryErr || !recoveryLink?.properties?.action_link) {
      console.log('generateLink(recovery) failed:', recoveryErr?.message)
    } else {
      console.log(`\nrequested redirectTo: ${recoveryRedirectTo}`)
      const result = await followLink(recoveryLink.properties.action_link, 'recovery -> /reset-password')
      console.log(`  Landed on intended path? ${result.finalPath === '/reset-password'}`)
      console.log(`  Looks like it fell back to landing/marketing page: ${result.looksLikeLanding}`)
    }

    // --- email_change_new, with the exact redirectTo our Settings page sets ---
    const emailChangeRedirectTo = `${BASE_URL}/auth/callback?type=email_change`
    const { data: emailChangeLink, error: emailChangeErr } = await admin.auth.admin.generateLink({
      type: 'email_change_new',
      email: EMAIL,
      newEmail: NEW_EMAIL,
      options: { redirectTo: emailChangeRedirectTo },
    })
    if (emailChangeErr || !emailChangeLink?.properties?.action_link) {
      console.log('\ngenerateLink(email_change_new) failed:', emailChangeErr?.message)
    } else {
      console.log(`\nrequested redirectTo: ${emailChangeRedirectTo}`)
      const result = await followLink(emailChangeLink.properties.action_link, 'email_change_new -> /auth/callback')
      console.log(`  Landed somewhere under /settings (expected final destination)? ${result.finalPath.startsWith('/settings')}`)
      console.log(`  Looks like it fell back to landing/marketing page: ${result.looksLikeLanding}`)
    }

    console.log('\n=== DONE ===')
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
