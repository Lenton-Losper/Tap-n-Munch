/**
 * Staging verification: authorize() and getRestaurantIdsForUser() must deny/exclude a
 * restaurant_users row once deleted_at is set (the "remove staff" soft-delete gap).
 * Exercises the real functions directly against staging Supabase -- no HTTP server needed.
 *
 *   npx tsx scripts/verify-restaurant-users-deleted-at-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || SERVICE_KEY

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const tag = `delat-${Date.now()}`

const created = {
  restaurantIds: [] as string[],
  userIds: [] as string[],
  restaurantUserIds: [] as string[],
}

async function cleanup() {
  if (process.env.PW_SKIP_CLEANUP) {
    console.log('PW_SKIP_CLEANUP set -- leaving fixtures in place for inspection:', JSON.stringify(created))
    return
  }
  if (created.restaurantUserIds.length) await db.from('restaurant_users').delete().in('id', created.restaurantUserIds)
  if (created.restaurantIds.length) await db.from('restaurants').delete().in('id', created.restaurantIds)
  if (created.userIds.length) {
    await db.from('users').delete().in('id', created.userIds)
    for (const id of created.userIds) {
      await db.auth.admin.deleteUser(id).catch(() => {})
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  // Fixture: a standalone restaurant + a manager-role staff member (owners can't be
  // soft-deleted by the existing route anyway -- manager is the realistic case).
  const email = `${tag}@flashtap-test.invalid`
  const { data: authUser, error: authError } = await db.auth.admin.createUser({
    email,
    password: `Tx!${Math.random().toString(36).slice(2)}Aa1`,
    email_confirm: true,
  })
  if (authError || !authUser.user) throw authError ?? new Error('createUser failed')
  const userId = authUser.user.id
  created.userIds.push(userId)

  const { error: publicUserError } = await db.from('users').insert({ id: userId, email })
  if (publicUserError) throw publicUserError

  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .insert({ name: `${tag} Restaurant` })
    .select('id')
    .single()
  if (restaurantError || !restaurant) throw restaurantError ?? new Error('restaurant insert failed')
  created.restaurantIds.push(restaurant.id)

  const { ensureRestaurantRolesSeeded } = await import('../lib/auth/create-restaurant')
  await ensureRestaurantRolesSeeded(db as any, restaurant.id)

  const { data: membership, error: membershipError } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restaurant.id, user_id: userId, role: 'manager' })
    .select('id')
    .single()
  if (membershipError || !membership) throw membershipError ?? new Error('restaurant_users insert failed')
  created.restaurantUserIds.push(membership.id)
  console.log('Fixture: manager-role staff member created -- OK')

  // ============================================================
  // Part 1: before soft-delete, authorize() and getRestaurantIdsForUser() both see them.
  // ============================================================
  console.log('\n--- Part 1: before removal, access is granted ---')
  const { authorize } = await import('../lib/permissions/authorize')
  const { getRestaurantIdsForUser } = await import('../lib/supabase/admin-restaurant-auth')
  const { PERMISSIONS } = await import('../lib/permissions')

  const idsBefore = await getRestaurantIdsForUser(db as any, userId)
  assert(idsBefore.includes(restaurant.id), 'expected getRestaurantIdsForUser to include the restaurant before removal')

  const allowedBefore = await authorize(userId, restaurant.id, PERMISSIONS.STOCK_VIEW)
  assert(allowedBefore === true, 'expected authorize() to grant a manager permission before removal')
  console.log('authorize() grants access, getRestaurantIdsForUser() includes the restaurant -- OK')

  // ============================================================
  // Part 2: soft-delete via the same mechanism the "remove staff" route uses.
  // ============================================================
  console.log('\n--- Part 2: soft-delete (deleted_at), same as DELETE /api/admin/staff/[userId] ---')
  const { error: softDeleteError } = await db
    .from('restaurant_users')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', membership.id)
  if (softDeleteError) throw softDeleteError

  const idsAfter = await getRestaurantIdsForUser(db as any, userId)
  assert(!idsAfter.includes(restaurant.id), 'expected getRestaurantIdsForUser to EXCLUDE the restaurant after soft-delete')

  const allowedAfter = await authorize(userId, restaurant.id, PERMISSIONS.STOCK_VIEW)
  assert(allowedAfter === false, 'expected authorize() to DENY the permission after soft-delete')
  console.log('After soft-delete: getRestaurantIdsForUser excludes the restaurant, authorize() denies -- OK (fix confirmed)')

  console.log('\nRESTAURANT_USERS_DELETED_AT_STAGING_VERIFY_OK')
}

main()
  .catch(async (error) => {
    console.error('RESTAURANT_USERS_DELETED_AT_STAGING_VERIFY_FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
