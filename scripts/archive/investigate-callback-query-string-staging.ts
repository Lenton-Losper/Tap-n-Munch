/**
 * Staging: isolate whether the allowlist match fails because of the
 * `?type=email_change` query string specifically, or because /auth/callback
 * (any form) isn't allowlisted at all. OAuth sign-in already redirects
 * through the bare /auth/callback (no query string) today, so if THAT is
 * honored while the `?type=email_change` variant isn't, the fix is as
 * simple as encoding the type differently (e.g. a distinct path instead of
 * a query string) rather than needing a dashboard allowlist change.
 *
 *   npx tsx scripts/investigate-callback-query-string-staging.ts
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

const tag = `cb-qs-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

function extractRedirectTo(actionLink: string): string {
  return new URL(actionLink).searchParams.get('redirect_to') || '(none)'
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

    const cases: Array<{ label: string; redirectTo: string }> = [
      { label: 'bare /auth/callback, no query', redirectTo: `${BASE_URL}/auth/callback` },
      { label: '/auth/callback?type=email_change', redirectTo: `${BASE_URL}/auth/callback?type=email_change` },
      { label: '/auth/callback/ (trailing slash)', redirectTo: `${BASE_URL}/auth/callback/` },
      { label: 'root domain only', redirectTo: `${BASE_URL}/` },
    ]

    for (const c of cases) {
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'email_change_new',
        email: EMAIL,
        newEmail: NEW_EMAIL,
        options: { redirectTo: c.redirectTo },
      })
      if (error || !data?.properties?.action_link) {
        console.log(`${c.label}: generateLink FAILED (${error?.message})`)
        continue
      }
      const got = extractRedirectTo(data.properties.action_link)
      console.log(`${c.label}`)
      console.log(`  requested: ${c.redirectTo}`)
      console.log(`  actual:    ${got}`)
      console.log(`  honored:   ${got === c.redirectTo}\n`)
    }
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
