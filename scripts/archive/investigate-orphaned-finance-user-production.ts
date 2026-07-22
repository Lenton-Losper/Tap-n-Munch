/**
 * Read-only: figure out what references the orphaned public.users row for
 * finance@taste-hospitalitygroup.com (id 6d019210-1166-49d0-b3ca-9cd0b49db105),
 * which has no backing auth.users record.
 *
 *   npx tsx scripts/investigate-orphaned-finance-user-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ORPHAN_USER_ID = '6d019210-1166-49d0-b3ca-9cd0b49db105'
const ORPHAN_EMAIL = 'finance@taste-hospitalitygroup.com'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url?.includes(PROD_REF)) throw new Error(`Refusing: SUPABASE_URL is not production (${url})`)
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data: fullRow, error: fullErr } = await admin
    .from('users')
    .select('*')
    .eq('id', ORPHAN_USER_ID)
    .maybeSingle()
  if (fullErr) throw fullErr
  console.log('Full public.users row:', JSON.stringify(fullRow, null, 2))

  const { data: ruRows, error: ruErr } = await admin
    .from('restaurant_users')
    .select('*')
    .eq('user_id', ORPHAN_USER_ID)
  if (ruErr) throw ruErr
  console.log('\nrestaurant_users where user_id matches:', JSON.stringify(ruRows, null, 2))

  const { data: smRows, error: smErr } = await admin
    .from('staff_members')
    .select('*')
    .ilike('email', ORPHAN_EMAIL)
  if (smErr) throw smErr
  console.log('\nstaff_members where email matches:', JSON.stringify(smRows, null, 2))

  const tablesWithInviteEmail = ['staff_invites', 'restaurant_invites']
  for (const table of tablesWithInviteEmail) {
    const { data, error } = await admin.from(table).select('*').ilike('email', ORPHAN_EMAIL)
    if (error) {
      console.log(`\n${table}: query error (table may not exist or column differs):`, error.message)
      continue
    }
    console.log(`\n${table} where email matches:`, JSON.stringify(data, null, 2))
  }

  const { data: restaurantsOwned, error: rErr } = await admin
    .from('restaurants')
    .select('id, name, owner_id')
    .eq('owner_id', ORPHAN_USER_ID)
  if (rErr) throw rErr
  console.log('\nrestaurants where owner_id matches:', JSON.stringify(restaurantsOwned, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
