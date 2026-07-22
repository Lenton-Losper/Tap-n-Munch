/**
 * Staging verification for the "Invalid permissions array" fix (Roles page).
 * Reproduces the real production scenario: a role whose stored permissions array carries
 * legacy/unknown values ("orders:amend", "orders:refund" -- confirmed present on 5 real
 * production restaurants' "manager" role, including FNB ChowNow), then edits it the way the
 * real UI does -- toggle one permission, save the whole array back.
 *
 * Exercises the real normalizePermissionsInput() and authorize() directly against staging.
 *
 *   npx tsx scripts/verify-role-permissions-save-staging.ts
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

const tag = `roleperm-${Date.now()}`
const ROLE_SLUG = 'manager'

const created = {
  restaurantIds: [] as string[],
  userIds: [] as string[],
}

async function cleanup() {
  if (process.env.PW_SKIP_CLEANUP) {
    console.log('PW_SKIP_CLEANUP set -- leaving fixtures in place for inspection:', JSON.stringify(created))
    return
  }
  if (created.restaurantIds.length) {
    await db.from('restaurant_users').delete().in('restaurant_id', created.restaurantIds)
    await db.from('restaurant_roles').delete().in('restaurant_id', created.restaurantIds)
    await db.from('restaurants').delete().in('id', created.restaurantIds)
  }
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
  const { ensureRestaurantRolesSeeded } = await import('../lib/auth/create-restaurant')
  const { normalizePermissionsInput } = await import('../lib/restaurant-roles/utils')
  const { authorize } = await import('../lib/permissions/authorize')
  const { PERMISSIONS } = await import('../lib/permissions')

  // Fixture: restaurant + seeded default roles, then overwrite "manager" with the exact
  // real-world broken shape -- current-but-partial permissions plus dead legacy values.
  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .insert({ name: `${tag} Restaurant` })
    .select('id')
    .single()
  if (restaurantError || !restaurant) throw restaurantError ?? new Error('restaurant insert failed')
  created.restaurantIds.push(restaurant.id)

  await ensureRestaurantRolesSeeded(db as any, restaurant.id)

  const brokenPermissions = [PERMISSIONS.STOCK_VIEW, 'orders:amend', 'orders:refund']
  const { error: brokenRoleError } = await db
    .from('restaurant_roles')
    .update({ permissions: brokenPermissions })
    .eq('restaurant_id', restaurant.id)
    .eq('role_slug', ROLE_SLUG)
  if (brokenRoleError) throw brokenRoleError
  console.log(`Fixture: "${ROLE_SLUG}" role seeded with real-world broken permissions ${JSON.stringify(brokenPermissions)} -- OK`)

  const email = `${tag}@flashtap-test.invalid`
  const { data: authUser, error: authError } = await db.auth.admin.createUser({
    email,
    password: `Tx!${Math.random().toString(36).slice(2)}Aa1`,
    email_confirm: true,
  })
  if (authError || !authUser.user) throw authError ?? new Error('createUser failed')
  const userId = authUser.user.id
  created.userIds.push(userId)
  await db.from('users').insert({ id: userId, email })
  await db.from('restaurant_users').insert({ restaurant_id: restaurant.id, user_id: userId, role: ROLE_SLUG })

  // ============================================================
  // Part 1: before the fix, this exact save would have failed with "Invalid permissions array".
  // ============================================================
  console.log('\n--- Part 1: user has the role\'s current (broken-data) permission ---')
  const beforeStockView = await authorize(userId, restaurant.id, PERMISSIONS.STOCK_VIEW)
  assert(beforeStockView === true, 'expected stock:view to be granted before the edit')
  const beforeMenuRead = await authorize(userId, restaurant.id, PERMISSIONS.MENU_READ)
  assert(beforeMenuRead === false, 'expected menu:read to NOT be granted before the edit')
  console.log('authorize(): stock:view=true, menu:read=false (matches seeded role) -- OK')

  // ============================================================
  // Part 2: simulate exactly what the real UI does on "Save changes" -- toggle ON one
  // permission, the legacy junk rides along untouched in the same array.
  // ============================================================
  console.log('\n--- Part 2: save changes (toggle menu:read ON), legacy junk still in the array ---')
  const savedPayload = [...brokenPermissions, PERMISSIONS.MENU_READ]
  const normalized = normalizePermissionsInput(savedPayload)
  assert(normalized !== null, 'expected normalizePermissionsInput to NOT reject the array (this was the bug)')
  assert(!normalized!.includes('orders:amend' as any), 'expected legacy "orders:amend" to be dropped')
  assert(!normalized!.includes('orders:refund' as any), 'expected legacy "orders:refund" to be dropped')
  assert(normalized!.includes(PERMISSIONS.STOCK_VIEW), 'expected stock:view to survive')
  assert(normalized!.includes(PERMISSIONS.MENU_READ), 'expected the newly toggled menu:read to be included')
  console.log(`normalizePermissionsInput() succeeded: ${JSON.stringify(normalized)} -- OK (previously returned null)`)

  const { error: updateError } = await db
    .from('restaurant_roles')
    .update({ permissions: normalized })
    .eq('restaurant_id', restaurant.id)
    .eq('role_slug', ROLE_SLUG)
  if (updateError) throw updateError

  // ============================================================
  // Part 3: reload from DB (persistence) and confirm authorize() reflects the change.
  // ============================================================
  console.log('\n--- Part 3: reload + authorize() reflects the saved change ---')
  const { data: reloaded, error: reloadError } = await db
    .from('restaurant_roles')
    .select('permissions')
    .eq('restaurant_id', restaurant.id)
    .eq('role_slug', ROLE_SLUG)
    .single()
  if (reloadError || !reloaded) throw reloadError ?? new Error('reload failed')
  assert(!reloaded.permissions.includes('orders:amend'), 'expected persisted permissions to have dropped legacy junk')
  assert(reloaded.permissions.includes(PERMISSIONS.MENU_READ), 'expected persisted permissions to include menu:read')
  console.log(`Reloaded role.permissions: ${JSON.stringify(reloaded.permissions)} -- persisted correctly, junk gone -- OK`)

  const afterMenuRead = await authorize(userId, restaurant.id, PERMISSIONS.MENU_READ)
  assert(afterMenuRead === true, 'expected menu:read to now be granted (gained via the edit)')
  console.log('authorize(): menu:read=true -- user gained the toggled permission -- OK')

  // ============================================================
  // Part 4: toggle OFF a permission, confirm authorize() denies it afterward.
  // ============================================================
  console.log('\n--- Part 4: save changes (toggle stock:view OFF) ---')
  const afterRemoveStockView = normalizePermissionsInput(
    normalized!.filter((p) => p !== PERMISSIONS.STOCK_VIEW),
  )
  assert(afterRemoveStockView !== null, 'expected normalizePermissionsInput to succeed')
  const { error: updateError2 } = await db
    .from('restaurant_roles')
    .update({ permissions: afterRemoveStockView })
    .eq('restaurant_id', restaurant.id)
    .eq('role_slug', ROLE_SLUG)
  if (updateError2) throw updateError2

  const finalStockView = await authorize(userId, restaurant.id, PERMISSIONS.STOCK_VIEW)
  assert(finalStockView === false, 'expected stock:view to be DENIED after removal')
  console.log('authorize(): stock:view=false -- user lost the untoggled permission -- OK')

  console.log('\nROLE_PERMISSIONS_SAVE_STAGING_VERIFY_OK')
}

main()
  .catch(async (error) => {
    console.error('ROLE_PERMISSIONS_SAVE_STAGING_VERIFY_FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
