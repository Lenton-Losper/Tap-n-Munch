import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const USER_ID = '52e102a1-7f67-4cef-a5b9-da9c7c24b090'

async function main() {
  const { data: setup, error: setupErr } = await admin
    .from('restaurant_setup_status')
    .select('*')
  console.log('restaurant_setup_status (any row referencing this user via restaurant, cannot filter by user directly):', setupErr ? setupErr.message : `${setup?.length ?? 0} total rows in table`)

  // Look for any orphan restaurants created around the same window with no owner link
  const { data: recentRestaurants, error: rErr } = await admin
    .from('restaurants')
    .select('id, name, owner_id, created_by, created_at')
    .gte('created_at', '2026-07-09T15:30:00Z')
    .order('created_at', { ascending: false })
  console.log('restaurants created since 15:30 UTC today:', rErr ? rErr.message : JSON.stringify(recentRestaurants, null, 2))

  // Check for other public.users rows created in a similar window with null restaurant_id (pattern check)
  const { data: stuckUsers, error: sErr } = await admin
    .from('users')
    .select('id, email, role, restaurant_id, created_at')
    .is('restaurant_id', null)
    .gte('created_at', '2026-07-08T00:00:00Z')
    .order('created_at', { ascending: false })
  console.log('public.users with null restaurant_id since 2026-07-08:', sErr ? sErr.message : JSON.stringify(stuckUsers, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
