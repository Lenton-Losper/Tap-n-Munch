/**
 * STAGING PROBE SETUP -- builds the two-restaurant account shape the switcher needs.
 *
 * No staging account holds more than one restaurant, so the switcher's visible path cannot be
 * observed without creating that shape. This goes through create_organization_location -- the same
 * RPC Add Location calls -- rather than hand-inserting rows, so the probe subject is built the way
 * a real second location is.
 *
 * Run:  set -a; . ./.env.test; set +a; node node_modules/tsx/dist/cli.mjs scripts/probe-switcher-staging-setup.ts
 */
import { createClient } from '@supabase/supabase-js'
import { buildDefaultRestaurantRolesSeed } from '../lib/auth/create-restaurant'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not the staging project -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROBE_EMAIL = 'flashtap.staging.test@gmail.com'
const LOCATION_NAME = 'Switcher Probe Location'

async function main() {
  const { data: user, error: userError } = await db
    .from('users')
    .select('id, email')
    .eq('email', PROBE_EMAIL)
    .maybeSingle()
  if (userError) throw userError
  if (!user) throw new Error(`probe user ${PROBE_EMAIL} not found on staging`)

  const { data: memberships, error: mErr } = await db
    .from('restaurant_users')
    .select('restaurant_id, role, deleted_at')
    .eq('user_id', user.id)
    .is('deleted_at', null)
  if (mErr) throw mErr

  const { data: baseRestaurant, error: rErr } = await db
    .from('restaurants')
    .select('id, name, organization_id')
    .eq('id', memberships[0].restaurant_id)
    .maybeSingle()
  if (rErr) throw rErr

  console.log('probe user      :', user.email, user.id)
  console.log('base restaurant :', baseRestaurant!.name, baseRestaurant!.id)
  console.log('organization    :', baseRestaurant!.organization_id)
  console.log('live memberships BEFORE:', memberships.length)

  const { data: existing } = await db
    .from('restaurants')
    .select('id, name')
    .eq('organization_id', baseRestaurant!.organization_id)
    .eq('name', LOCATION_NAME)
    .maybeSingle()

  let newRestaurantId: string
  if (existing) {
    console.log('\nprobe location already exists, reusing:', existing.id)
    newRestaurantId = existing.id
  } else {
    const { data: created, error: rpcError } = await db.rpc('create_organization_location', {
      p_organization_id: baseRestaurant!.organization_id,
      p_created_by_user_id: user.id,
      p_name: LOCATION_NAME,
      p_address: null,
      p_roles: buildDefaultRestaurantRolesSeed(),
      p_copy_stock_config_from_restaurant_id: null,
    })
    if (rpcError) throw rpcError
    newRestaurantId = String(created)
    console.log('\ncreated via create_organization_location:', newRestaurantId)
  }

  const { data: after, error: aErr } = await db
    .from('restaurant_users')
    .select('restaurant_id, role, deleted_at, created_at')
    .eq('user_id', user.id)
    .is('deleted_at', null)
  if (aErr) throw aErr

  const { data: names } = await db.from('restaurants').select('id, name').range(0, 999)
  const nameOf = (id: string) => names?.find((n) => n.id === id)?.name ?? id

  console.log('\nlive memberships AFTER:', after.length)
  for (const m of after) {
    console.log(`   ${nameOf(m.restaurant_id).padEnd(28)} role=${m.role}  ${m.restaurant_id}`)
  }

  const { data: ctx } = await db
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', user.id)
    .maybeSingle()
  console.log('\nuser_active_context:', JSON.stringify(ctx), '->', ctx?.restaurant_id ? nameOf(ctx.restaurant_id) : 'none')
  console.log('\nPROBE_USER_ID=' + user.id)
  console.log('PROBE_NEW_RESTAURANT_ID=' + newRestaurantId)
  console.log('PROBE_BASE_RESTAURANT_ID=' + baseRestaurant!.id)
}

main().catch((error) => {
  console.error('FAILED:', error)
  process.exit(1)
})
