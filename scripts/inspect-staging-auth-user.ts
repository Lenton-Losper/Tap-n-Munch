import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const email = (process.env.BOOTSTRAP_EMAIL || 'llosperofficial@gmail.com').toLowerCase()
const password = process.env.BOOTSTRAP_PASSWORD || ''

if (!url.includes(STAGING_REF) || !key) {
  throw new Error('bad creds')
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

async function find(target: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const found = (data.users || []).find((u) => (u.email || '').toLowerCase() === target)
    if (found) return found
    if ((data.users || []).length < 200) break
  }
  return null
}

async function main() {
  const user = await find(email)
  if (!user) {
    console.log('USER_NOT_FOUND')
    process.exit(1)
  }

  console.log(
    JSON.stringify(
      {
        id: user.id,
        email: user.email,
        email_confirmed_at: user.email_confirmed_at,
        banned_until: (user as { banned_until?: string | null }).banned_until ?? null,
        is_anonymous: (user as { is_anonymous?: boolean }).is_anonymous ?? false,
        providers: user.app_metadata?.providers,
        last_sign_in_at: user.last_sign_in_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
      null,
      2,
    ),
  )

  if (password) {
    const anon = process.env.STAGING_SUPABASE_ANON_KEY || ''
    if (!anon) {
      console.log('ANON_SIGNIN SKIP: missing anon key')
      return
    }
    const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    console.log(error ? `ANON_SIGNIN FAIL:${error.message}` : `ANON_SIGNIN OK:${data.user?.id}`)
    if (!error) await client.auth.signOut()
  }
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
