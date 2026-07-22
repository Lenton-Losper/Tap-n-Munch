/**
 * Read-only: verify the auth.users.email rollback actually landed after the
 * failed public.users write, and identify who currently owns
 * finance@taste-hospitalitygroup.com in public.users / auth.users.
 *
 *   npx tsx scripts/investigate-chownow-email-conflict-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const CHOWNOW_USER_ID = 'b2660df1-a9fa-45a6-9705-79cbbd07102f'
const OLD_EMAIL = 'flashtaptestacc1@gmail.com'
const CONFLICT_EMAIL = 'finance@taste-hospitalitygroup.com'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url?.includes(PROD_REF)) throw new Error(`Refusing: SUPABASE_URL is not production (${url})`)
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  console.log('--- Rollback verification for ChowNow owner ---')
  const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(CHOWNOW_USER_ID)
  if (authErr) throw authErr
  console.log(`auth.users.email now: ${authUser.user?.email}`)
  console.log(`Matches OLD_EMAIL (${OLD_EMAIL}): ${authUser.user?.email?.toLowerCase() === OLD_EMAIL.toLowerCase()}`)

  const { data: publicUser, error: publicErr } = await admin
    .from('users')
    .select('id, email')
    .eq('id', CHOWNOW_USER_ID)
    .maybeSingle()
  if (publicErr) throw publicErr
  console.log(`public.users.email now: ${publicUser?.email}`)
  console.log(`Matches OLD_EMAIL: ${publicUser?.email?.toLowerCase() === OLD_EMAIL.toLowerCase()}\n`)

  console.log(`--- Who currently owns ${CONFLICT_EMAIL} ---`)
  const { data: conflictRows, error: conflictErr } = await admin
    .from('users')
    .select('id, email, name')
    .ilike('email', CONFLICT_EMAIL)
  if (conflictErr) throw conflictErr
  console.log('public.users match:', JSON.stringify(conflictRows, null, 2))

  for (const row of conflictRows ?? []) {
    const { data: authMatch, error: authMatchErr } = await admin.auth.admin.getUserById(row.id)
    if (authMatchErr) {
      console.log(`  auth.users lookup for ${row.id} failed:`, authMatchErr.message)
      continue
    }
    console.log(`  auth.users for ${row.id}: email=${authMatch.user?.email}, created_at=${authMatch.user?.created_at}, last_sign_in_at=${authMatch.user?.last_sign_in_at}`)

    const { data: ruRows, error: ruErr } = await admin
      .from('restaurant_users')
      .select('restaurant_id, role, deleted_at')
      .eq('user_id', row.id)
    if (ruErr) throw ruErr
    console.log(`  restaurant_users for ${row.id}:`, JSON.stringify(ruRows, null, 2))
  }

  // Also check by email directly in auth (in case a public.users row is missing/orphaned the other way)
  const { data: page, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 })
  if (listErr) throw listErr
  const authMatches = page.users.filter((u) => u.email?.toLowerCase() === CONFLICT_EMAIL.toLowerCase())
  console.log(`\nauth.users direct match for ${CONFLICT_EMAIL} (via listUsers scan):`, JSON.stringify(
    authMatches.map((u) => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at })),
    null,
    2,
  ))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
