/**
 * One-time bootstrap for the Super Admin Dashboard (#13): the platform_admins invite flow
 * has no one to invite from initially, so this creates the first platform admin directly.
 *
 * 1. Creates a real staging auth.users account for the given email (if it doesn't exist).
 * 2. Prints the generated password (report this to the requester directly; never store it
 *    in a committed file).
 * 3. Does NOT insert the platform_admins row itself -- that's done by the companion
 *    migration (20260716140000_bootstrap_platform_admin.sql), which looks the user up by
 *    email rather than hardcoding a UUID.
 *
 *   npx tsx scripts/apply-platform-admin-bootstrap-staging.ts <email>
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomBytes } from 'crypto'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const symbols = '!@#$%^&*-_=+'
  const all = upper + lower + digits + symbols
  const pick = (set: string) => set[randomBytes(1)[0] % set.length]
  let pw = pick(upper) + pick(lower) + pick(digits) + pick(symbols)
  for (let i = 0; i < 16; i++) pw += pick(all)
  const arr = pw.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

async function main() {
  const email = process.argv[2]
  if (!email) throw new Error('Usage: apply-platform-admin-bootstrap-staging.ts <email>')

  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const found = existing.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase())

  if (found) {
    console.log(`Account already exists for ${email} (id=${found.id}). No account created.`)
    console.log(`RESULT_USER_ID=${found.id}`)
    return
  }

  const password = generatePassword()
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !created.user) throw error || new Error('createUser failed')

  console.log(`Created staging auth account for ${email} (id=${created.user.id})`)
  console.log(`RESULT_USER_ID=${created.user.id}`)
  console.log(`RESULT_PASSWORD=${password}`)
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
