/**
 * Staging verification for email/password signup atomicity (#36).
 *
 * Reproduces the exact sequence in app/api/auth/signup/route.ts:
 *   - auth.admin.createUser
 *   - createRestaurantForUserAtomic (create_restaurant_for_user RPC)
 * and confirms:
 *   1. Happy path creates public.users + restaurant + roles + membership +
 *      setup_status atomically, with no orphan restaurants.
 *   2. Failure path (RPC rejects a second restaurant for the same user)
 *      leaves no partial second restaurant, matching route.ts's
 *      catch-then-deleteUser rollback behavior.
 *
 *   npx tsx scripts/verify-email-password-signup-staging.ts
 *
 * Requires migration 20260709180000_create_restaurant_for_user on staging.
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
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

async function cleanup(params: { authUserId: string | null; restaurantIds: string[] }) {
  for (const restaurantId of params.restaurantIds) {
    await admin.from('restaurants').delete().eq('id', restaurantId)
  }
  if (params.authUserId) {
    await admin.from('users').delete().eq('id', params.authUserId)
    await admin.auth.admin.deleteUser(params.authUserId).catch(() => {})
  }
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  const email = `email-signup-verify-${tag}@example.com`
  let authUserId: string | null = null
  const restaurantIds: string[] = []

  console.log(`[${ts()}] === Email/password signup staging verification (#36) ===`)
  console.log(`[${ts()}] email=${email}`)

  try {
    const orphansBefore = await countOrphanRestaurants()
    console.log(`[${ts()}] orphan restaurants before test: ${orphansBefore}`)

    // Mirrors route.ts: auth.admin.createUser happens first, standalone.
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password: STAGING_TEST_PASSWORD,
      email_confirm: true,
    })
    if (authError || !authData.user?.id) {
      throw authError || new Error('Failed to create auth user')
    }
    authUserId = authData.user.id
    console.log(`[${ts()}] created auth user ${authUserId}`)

    // Happy path: mirrors route.ts's single call to createRestaurantForUserAtomic.
    const restaurantId = await createRestaurantForUserAtomic(admin, {
      userId: authUserId,
      email,
      fullName: `Email Signup Verify ${tag}`,
      phone: '0812345678',
      restaurantName: `Email Signup Verify Restaurant ${tag}`,
    })
    restaurantIds.push(restaurantId)

    const { data: publicUser, error: publicUserError } = await admin
      .from('users')
      .select('id, email, full_name, phone')
      .eq('id', authUserId)
      .maybeSingle()
    if (publicUserError) throw publicUserError
    await assert(publicUser?.id === authUserId, 'public.users row created for new auth user')
    await assert(publicUser?.email === email, 'public.users email matches')

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

    const orphansAfterHappyPath = await countOrphanRestaurants()
    await assert(
      orphansAfterHappyPath === orphansBefore,
      `no new orphan restaurants after happy path (before=${orphansBefore}, after=${orphansAfterHappyPath})`,
    )

    // Failure path: same user already has a restaurant -> RPC must raise and
    // must not create a second, partially-linked restaurant (matches
    // route.ts's catch block, which deletes the auth user on any failure).
    let secondCallFailed = false
    try {
      const secondRestaurantId = await createRestaurantForUserAtomic(admin, {
        userId: authUserId,
        email,
        fullName: `Email Signup Verify ${tag}`,
        phone: '0812345678',
        restaurantName: `Email Signup Verify Restaurant ${tag} (duplicate)`,
      })
      restaurantIds.push(secondRestaurantId)
    } catch (error) {
      secondCallFailed = true
      console.log(`[${ts()}] second call rejected as expected: ${errorMessage(error)}`)
    }
    await assert(secondCallFailed, 'second create_restaurant_for_user call for same user rejected')

    const orphansAfterFailurePath = await countOrphanRestaurants()
    await assert(
      orphansAfterFailurePath === orphansBefore,
      `no orphan restaurants after rejected duplicate call (before=${orphansBefore}, after=${orphansAfterFailurePath})`,
    )

    console.log(`\n[${ts()}] Email/password signup verification passed.`)
  } finally {
    await cleanup({ authUserId, restaurantIds })
    console.log(`[${ts()}] cleanup complete for ${email}`)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
