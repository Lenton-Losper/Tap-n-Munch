import { createClient } from '@supabase/supabase-js'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const email = (process.env.BOOTSTRAP_EMAIL || 'llosperofficial@gmail.com').toLowerCase()
const password = process.env.BOOTSTRAP_PASSWORD || ''
if (!url.includes(STAGING_REF) || !key) throw new Error('bad creds')
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

async function find(email: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const found = (data.users || []).find((u) => (u.email || '').toLowerCase() === email)
    if (found) return found
    if ((data.users || []).length < 200) break
  }
  return null
}

const user = await find(email)
if (!user) {
  console.log('USER_NOT_FOUND')
  process.exit(1)
}
console.log(JSON.stringify({
  id: user.id,
  email: user.email,
  email_confirmed_at: user.email_confirmed_at,
  banned_until: (user as any).banned_until ?? null,
  deleted: (user as any).deleted ?? null,
  providers: user.app_metadata?.providers,
  last_sign_in_at: user.last_sign_in_at,
  created_at: user.created_at,
  updated_at: user.updated_at,
}, null, 2))

if (password) {
  const anon = process.env.STAGING_SUPABASE_ANON_KEY || ''
  const client = createClient(url, anon || key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  console.log('ANON_SIGNIN', error ? `FAIL:${error.message}` : `OK:${data.user?.id}`)
}
