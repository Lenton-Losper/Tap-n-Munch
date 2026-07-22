/**
 * Remediation for one already-broken account: public.users exists and is
 * correctly linked, but restaurant creation never completed. Calls the
 * app's own createRestaurantForUserAtomic (same code path a real signup
 * uses) directly against production for a named account.
 *
 * Usage: npx tsx scripts/.remediate-account.ts <userId> <email> <fullName> <phoneOrEmpty> <restaurantName>
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { createRestaurantForUserAtomic } from '@/lib/auth/create-restaurant'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(PROD_REF) || !SERVICE_KEY) throw new Error('Refusing: wrong env')

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const [userId, email, fullName, phone, restaurantName] = process.argv.slice(2)
  if (!userId || !email || !fullName || !restaurantName) {
    throw new Error('Usage: userId email fullName phone restaurantName')
  }

  console.log(`Remediating ${email} (${userId})`)
  console.log(`  restaurantName="${restaurantName}" phone="${phone || '(none)'}"`)

  const { data: existingMembership } = await admin
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (existingMembership?.restaurant_id) {
    throw new Error(`Already has a restaurant (${existingMembership.restaurant_id}) — refusing to run again`)
  }

  const restaurantId = await createRestaurantForUserAtomic(admin, {
    userId,
    email,
    fullName,
    phone: phone || '',
    restaurantName,
  })
  console.log(`  createRestaurantForUserAtomic returned restaurantId=${restaurantId}`)

  const { data: membership, error: membershipError } = await admin
    .from('restaurant_users')
    .select('restaurant_id, role')
    .eq('user_id', userId)
    .maybeSingle()
  console.log('  restaurant_users after:', membershipError ? membershipError.message : JSON.stringify(membership))

  const { data: restaurant, error: restaurantError } = await admin
    .from('restaurants')
    .select('id, name, phone')
    .eq('id', restaurantId)
    .maybeSingle()
  console.log('  restaurants row:', restaurantError ? restaurantError.message : JSON.stringify(restaurant))

  const { count: rolesCount } = await admin
    .from('restaurant_roles')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
  console.log('  restaurant_roles count:', rolesCount)

  const { count: setupCount } = await admin
    .from('restaurant_setup_status')
    .select('restaurant_id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
  console.log('  restaurant_setup_status count:', setupCount)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
