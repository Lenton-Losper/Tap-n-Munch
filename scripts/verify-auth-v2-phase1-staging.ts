/**
 * Staging verification for Authorization v2 Phase 1.
 * Run after applying migration 20260704150000_auth_v2_bar_role.sql:
 *   npx tsx scripts/verify-auth-v2-phase1-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { parseStaffRole } from '../lib/permissions/staff-role'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../lib/permissions'

config({ path: '.env.test' })

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test')
}

const TEST_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const TEST_EMAIL = 'staging.kitchen.test@gmail.com'
const TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORIGINAL_ROLE = 'kitchen'

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`OK: ${message}`)
}

async function resolveStaffMemberId(userId: string, restaurantId: string): Promise<string | null> {
  const { data: userRow } = await admin.from('users').select('email').eq('id', userId).maybeSingle()
  const email = String(userRow?.email || '').trim().toLowerCase()
  if (!email) return null

  const { data: member } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .ilike('email', email)
    .maybeSingle()

  return member?.id ? String(member.id) : null
}

async function authorizeLike(
  userId: string,
  restaurantId: string,
  permission: string,
): Promise<boolean> {
  const { data: membership } = await admin
    .from('restaurant_users')
    .select('role')
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  const role = membership?.role
  if (!role) return false

  const defaultPerms = ROLE_PERMISSIONS[role] ?? []
  let allowed = defaultPerms.includes(permission as (typeof defaultPerms)[number])

  const staffMemberId = await resolveStaffMemberId(userId, restaurantId)
  if (staffMemberId) {
    const { data: overrides } = await admin
      .from('staff_permissions')
      .select('permission, effect')
      .eq('staff_id', staffMemberId)
      .eq('permission', permission)
      .eq('restaurant_id', restaurantId)

    if (overrides && overrides.length > 0) {
      allowed = overrides[0].effect === 'allow'
    }
  }

  return allowed
}

async function main() {
  console.log('=== Auth v2 Phase 1 staging verification ===\n')

  const { error: barUpdateError } = await admin
    .from('restaurant_users')
    .update({ role: 'bar', updated_at: new Date().toISOString() })
    .eq('user_id', TEST_USER_ID)
    .eq('restaurant_id', TEST_RESTAURANT_ID)

  await assert(!barUpdateError, `restaurant_users accepts role=bar (${barUpdateError?.message ?? 'no error'})`)

  const { data: barRow } = await admin
    .from('restaurant_users')
    .select('role')
    .eq('user_id', TEST_USER_ID)
    .maybeSingle()

  await assert(barRow?.role === 'bar', 'bar role row persisted in DB')
  await assert(parseStaffRole(barRow?.role) === 'bar', 'parseStaffRole reads bar')

  const { error: cashierUpdateError } = await admin
    .from('restaurant_users')
    .update({ role: 'cashier', updated_at: new Date().toISOString() })
    .eq('user_id', TEST_USER_ID)
    .eq('restaurant_id', TEST_RESTAURANT_ID)

  await assert(
    !cashierUpdateError,
    `restaurant_users accepts role=cashier (${cashierUpdateError?.message ?? 'no error'})`,
  )

  const { data: cashierRow } = await admin
    .from('restaurant_users')
    .select('role')
    .eq('user_id', TEST_USER_ID)
    .maybeSingle()

  await assert(cashierRow?.role === 'cashier', 'cashier role row persisted in DB')
  await assert(parseStaffRole(cashierRow?.role) === 'cashier', 'parseStaffRole reads cashier')

  await admin
    .from('restaurant_users')
    .update({ role: ORIGINAL_ROLE, updated_at: new Date().toISOString() })
    .eq('user_id', TEST_USER_ID)
    .eq('restaurant_id', TEST_RESTAURANT_ID)

  let staffMemberId: string | null = null

  const { data: existingMember } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', TEST_RESTAURANT_ID)
    .ilike('email', TEST_EMAIL)
    .maybeSingle()

  if (existingMember?.id) {
    staffMemberId = String(existingMember.id)
  } else {
    const { data: inserted, error: insertMemberError } = await admin
      .from('staff_members')
      .insert({
        restaurant_id: TEST_RESTAURANT_ID,
        email: TEST_EMAIL,
        role: ORIGINAL_ROLE,
        active: true,
      })
      .select('id')
      .single()

    if (insertMemberError) throw insertMemberError
    staffMemberId = String(inserted.id)
  }

  await assert(Boolean(staffMemberId), `staff_members row ready (${staffMemberId})`)

  const resolvedId = await resolveStaffMemberId(TEST_USER_ID, TEST_RESTAURANT_ID)
  await assert(resolvedId === staffMemberId, 'resolveStaffMemberId maps userId → staff_members.id')

  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId!)

  const beforeAllow = await authorizeLike(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)
  await assert(beforeAllow === false, 'kitchen default denies recipe:view')

  const { error: allowInsertError } = await admin.from('staff_permissions').insert({
    staff_id: staffMemberId,
    restaurant_id: TEST_RESTAURANT_ID,
    permission: PERMISSIONS.RECIPE_VIEW,
    effect: 'allow',
  })
  await assert(!allowInsertError, 'staff_permissions allow override inserted')

  const afterAllow = await authorizeLike(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)
  await assert(afterAllow === true, 'authorize() logic respects allow override via staff_members.id')

  const { error: denyUpsertError } = await admin.from('staff_permissions').upsert({
    staff_id: staffMemberId,
    restaurant_id: TEST_RESTAURANT_ID,
    permission: PERMISSIONS.RECIPE_VIEW,
    effect: 'deny',
  })
  await assert(!denyUpsertError, 'staff_permissions deny override upserted')

  const afterDeny = await authorizeLike(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)
  await assert(afterDeny === false, 'authorize() logic respects deny override via staff_members.id')

  console.log('\n=== Cleanup ===')
  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId!)
  await admin.from('staff_members').delete().eq('id', staffMemberId!)
  await admin
    .from('restaurant_users')
    .update({ role: ORIGINAL_ROLE, updated_at: new Date().toISOString() })
    .eq('user_id', TEST_USER_ID)
    .eq('restaurant_id', TEST_RESTAURANT_ID)

  console.log('Cleanup complete. All Phase 1 checks passed.')
}

main().catch((error) => {
  console.error('\nVerification failed:', error)
  process.exit(1)
})
