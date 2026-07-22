/**
 * Read-only: figure out exactly how FNB ChowNow's owner is linked
 * (restaurants.owner_id, restaurant_users, staff_members) before
 * attempting any email-change mutation.
 *
 *   npx tsx scripts/investigate-chownow-owner-linkage-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const CHOWNOW_RESTAURANT_ID = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const OLD_EMAIL = 'flashtaptestacc1@gmail.com'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url?.includes(PROD_REF)) throw new Error(`Refusing: SUPABASE_URL is not production (${url})`)
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data: userRows, error: userErr } = await admin
    .from('users')
    .select('id, email, name')
    .ilike('email', OLD_EMAIL)
  if (userErr) throw userErr
  console.log('public.users match:', JSON.stringify(userRows, null, 2))
  const userId = userRows?.[0]?.id

  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .select('id, name, owner_id')
    .eq('id', CHOWNOW_RESTAURANT_ID)
    .maybeSingle()
  if (restErr) throw restErr
  console.log('\nrestaurants row:', JSON.stringify(restaurant, null, 2))
  console.log('owner_id matches user.id:', restaurant?.owner_id === userId)

  const { data: ruRows, error: ruErr } = await admin
    .from('restaurant_users')
    .select('*')
    .eq('restaurant_id', CHOWNOW_RESTAURANT_ID)
  if (ruErr) throw ruErr
  console.log('\nrestaurant_users rows for ChowNow:', JSON.stringify(ruRows, null, 2))

  const { data: smAll, error: smErr } = await admin
    .from('staff_members')
    .select('id, email, role, restaurant_id')
    .eq('restaurant_id', CHOWNOW_RESTAURANT_ID)
  if (smErr) throw smErr
  console.log('\nALL staff_members rows for ChowNow (any email):', JSON.stringify(smAll, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
