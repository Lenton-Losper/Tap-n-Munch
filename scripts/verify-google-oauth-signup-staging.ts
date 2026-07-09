/**
 * Staging verification for Google OAuth new-restaurant signup (#35).
 *
 * Reproduces the production failure mode:
 *   - auth.users exists for email
 *   - stale public.users row exists for same email under a different id (no links)
 *   - ensurePublicUserForOAuth reconciles the stale row
 *   - create-restaurant completes atomically without orphan restaurants
 *
 *   npx tsx scripts/verify-google-oauth-signup-staging.ts
 *
 * Requires migration 20260709180000_create_restaurant_for_user on staging.
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { ensurePublicUserForOAuth } from '@/lib/auth/ensure-public-user'
import { createRestaurantForUserAtomic } from '@/lib/auth/create-restaurant'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const STAGING_TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

async function countOrphanRestaurants(): Promise<number> {
  const { data: restaurants, error } = await admin.from('restaurants').select('id')
  if (error) throw error

  const ids = (restaurants ?? []).map((row) => row.id)
  if (ids.length === 0) return 0

  const { data: linked, error: linkedError } = await admin
    .from('restaurant_users')
    .select('restaurant_id')
    .in('restaurant_id', ids)

  if (linkedError) throw linkedError

  const linkedIds = new Set((linked ?? []).map((row) => row.restaurant_id))
  return ids.filter((id) => !linkedIds.has(id)).length
}

async function cleanup(params: {
  authUserId: string | null
  stalePublicUserId: string | null
  restaurantId: string | null
}) {
  if (params.restaurantId) {
    await admin.from('restaurants').delete().eq('id', params.restaurantId)
  }
  if (params.authUserId) {
    await admin.from('users').delete().eq('id', params.authUserId)
    await admin.auth.admin.deleteUser(params.authUserId).catch(() => {})
  }
  if (params.stalePublicUserId) {
    await admin.from('users').delete().eq('id', params.stalePublicUserId)
  }
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  const email = `google-oauth-verify-${tag}@example.com`
  const stalePublicUserId = randomUUID()
  let authUserId: string | null = null
  let restaurantId: string | null = null

  console.log(`[${ts()}] === Google OAuth signup staging verification (#35) ===`)
  console.log(`[${ts()}] email=${email}`)

  try {
    const orphansBefore = await countOrphanRestaurants()
    console.log(`[${ts()}] orphan restaurants before test: ${orphansBefore}`)

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password: STAGING_TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: `OAuth Verify ${tag}`,
        avatar_url: 'https://example.com/avatar.png',
      },
    })
    if (authError || !authData.user?.id) {
      throw authError || new Error('Failed to create auth user')
    }
    authUserId = authData.user.id

    const { error: staleInsertError } = await admin.from('users').insert({
      id: stalePublicUserId,
      email,
      full_name: 'Stale Orphan Shell',
      phone: '0810000000',
    })
    if (staleInsertError) throw staleInsertError
    console.log(`[${ts()}] inserted stale public.users id=${stalePublicUserId}`)

    const ensured = await ensurePublicUserForOAuth(admin, {
      id: authUserId,
      email,
      fullName: `OAuth Verify ${tag}`,
      avatarUrl: 'https://example.com/avatar.png',
    })
    await assert(ensured.ok, 'ensurePublicUserForOAuth reconciled stale email collision')

    const { data: publicUser, error: publicUserError } = await admin
      .from('users')
      .select('id, email')
      .ilike('email', email)
      .maybeSingle()
    if (publicUserError) throw publicUserError
    await assert(publicUser?.id === authUserId, 'public.users id matches auth.users after reconcile')
    await assert(
      publicUser?.id !== stalePublicUserId,
      'stale public.users id was removed/replaced',
    )

    const { count: staleCount, error: staleLookupError } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('id', stalePublicUserId)
    if (staleLookupError) throw staleLookupError
    await assert(staleCount === 0, 'stale public.users row no longer exists')

    restaurantId = await createRestaurantForUserAtomic(admin, {
      userId: authUserId,
      email,
      fullName: `OAuth Verify ${tag}`,
      phone: '0812345678',
      restaurantName: `OAuth Verify Restaurant ${tag}`,
    })

    const { data: membership, error: membershipError } = await admin
      .from('restaurant_users')
      .select('restaurant_id, role')
      .eq('user_id', authUserId)
      .maybeSingle()
    if (membershipError) throw membershipError
    await assert(membership?.restaurant_id === restaurantId, 'restaurant_users links owner to new restaurant')
    await assert(membership?.role === 'owner', 'restaurant_users role is owner')

    const { count: rolesCount, error: rolesError } = await admin
      .from('restaurant_roles')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
    if (rolesError) throw rolesError
    await assert((rolesCount ?? 0) === 6, 'restaurant_roles seeded (6 roles)')

    const { count: setupCount, error: setupError } = await admin
      .from('restaurant_setup_status')
      .select('restaurant_id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
    if (setupError) throw setupError
    await assert((setupCount ?? 0) === 1, 'restaurant_setup_status row created')

    const orphansAfter = await countOrphanRestaurants()
    await assert(
      orphansAfter === orphansBefore,
      `no new orphan restaurants (before=${orphansBefore}, after=${orphansAfter})`,
    )

    console.log(`\n[${ts()}] Google OAuth signup verification passed.`)
  } finally {
    await cleanup({ authUserId, stalePublicUserId, restaurantId })
    console.log(`[${ts()}] cleanup complete for ${email}`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
