/**
 * Production (write, self-cleaning, ephemeral user only): checks the actual
 * redirect_to allowlist behavior for recovery and email_change link types,
 * mirroring the staging differential test that found only /reset-password
 * is allowlisted there (not even the bare domain root). generateLink never
 * sends real email regardless of type, so this is safe -- no real customer
 * is touched or emailed.
 *
 *   npx tsx scripts/investigate-link-redirect-allowlist-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.flashtap.app').replace(/\/$/, '')

if (!SUPABASE_URL.includes(PROD_REF)) throw new Error(`Refusing: SUPABASE_URL is not production (${SUPABASE_URL})`)
if (!SERVICE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env.production.local')

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `redir-allowlist-prod-${Date.now()}`
const EMAIL = `${tag}@example.com`
const NEW_EMAIL = `${tag}.new@example.com`

function extractRedirectTo(actionLink: string): string {
  return new URL(actionLink).searchParams.get('redirect_to') || '(none)'
}

async function main() {
  let userId: string | undefined
  try {
    console.log('=== Production redirect_to allowlist check ===')
    console.log(`Project ref: ${PROD_REF}`)
    console.log(`BASE_URL: ${BASE_URL}\n`)

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: EMAIL,
      email_confirm: true,
    })
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed')
    userId = created.user.id
    console.log(`Created ephemeral user ${userId} (${EMAIL}) -- no password set, never signed in, deleted at end.\n`)

    const cases: Array<{ label: string; type: 'recovery' | 'email_change_new'; redirectTo: string }> = [
      { label: 'recovery -> /reset-password', type: 'recovery', redirectTo: `${BASE_URL}/reset-password` },
      { label: 'recovery -> root domain', type: 'recovery', redirectTo: `${BASE_URL}/` },
      { label: 'recovery -> /auth/callback?type=email_change', type: 'recovery', redirectTo: `${BASE_URL}/auth/callback?type=email_change` },
      { label: 'email_change_new -> /auth/callback?type=email_change', type: 'email_change_new', redirectTo: `${BASE_URL}/auth/callback?type=email_change` },
      { label: 'email_change_new -> /reset-password', type: 'email_change_new', redirectTo: `${BASE_URL}/reset-password` },
      // Apex domain (no "www") -- a very common real-world mismatch cause
      { label: 'recovery -> apex domain /reset-password (no www)', type: 'recovery', redirectTo: 'https://flashtap.app/reset-password' },
      { label: 'recovery -> apex domain root (no www)', type: 'recovery', redirectTo: 'https://flashtap.app/' },
      // Riviera custom subdomain
      { label: 'recovery -> riviera.flashtap.app/reset-password', type: 'recovery', redirectTo: 'https://riviera.flashtap.app/reset-password' },
    ]

    for (const c of cases) {
      const params: Parameters<typeof admin.auth.admin.generateLink>[0] =
        c.type === 'recovery'
          ? { type: 'recovery', email: EMAIL, options: { redirectTo: c.redirectTo } }
          : { type: 'email_change_new', email: EMAIL, newEmail: NEW_EMAIL, options: { redirectTo: c.redirectTo } }

      const { data, error } = await admin.auth.admin.generateLink(params)
      if (error || !data?.properties?.action_link) {
        console.log(`${c.label}: generateLink FAILED (${error?.message})`)
        continue
      }
      const got = extractRedirectTo(data.properties.action_link)
      console.log(c.label)
      console.log(`  requested: ${c.redirectTo}`)
      console.log(`  actual:    ${got}`)
      console.log(`  honored:   ${got === c.redirectTo}\n`)
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
