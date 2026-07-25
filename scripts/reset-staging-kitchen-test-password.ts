/**
 * Reset password for an existing staging auth user via Admin API
 * (auth.admin.updateUserById) — same method as upsert-staging-platform-admin.
 *
 * Env:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (must be staging mdqjpxwczrhkxkbqatqa)
 *   RESET_EMAIL
 *   RESET_PASSWORD
 *
 * Never logs the password.
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''
const email = (process.env.RESET_EMAIL || '').trim().toLowerCase()
const password = process.env.RESET_PASSWORD || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging Supabase credentials missing or wrong project')
}
if (!email || !password) {
  throw new Error('RESET_EMAIL and RESET_PASSWORD are required')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function findUserByEmail(target: string) {
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
  const user = await findUserByEmail(email)
  if (!user) {
    throw new Error(`Auth user not found for ${email}`)
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password,
    email_confirm: true,
  })
  if (error) throw error

  console.log(`Updated password for existing auth user ${email} id=${user.id}`)
  console.log('RESET_STAGING_KITCHEN_PASSWORD_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
