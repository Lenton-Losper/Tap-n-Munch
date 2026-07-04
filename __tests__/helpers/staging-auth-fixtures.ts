import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const STAGING_TEST_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
export const STAGING_TEST_EMAIL = 'staging.kitchen.test@gmail.com'
export const STAGING_TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
export const STAGING_TEST_ROLE = 'kitchen'

export function createStagingAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function ensureStagingKitchenTestUser(admin: SupabaseClient): Promise<void> {
  const { error } = await admin
    .from('restaurant_users')
    .update({ role: STAGING_TEST_ROLE, updated_at: new Date().toISOString() })
    .eq('user_id', STAGING_TEST_USER_ID)
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)

  if (error) throw error
}

export async function ensureStagingStaffMember(admin: SupabaseClient): Promise<string> {
  const { data: restaurant, error: restaurantError } = await admin
    .from('restaurants')
    .select('id')
    .eq('id', STAGING_TEST_RESTAURANT_ID)
    .maybeSingle()

  if (restaurantError) throw restaurantError
  if (!restaurant?.id) {
    throw new Error(
      `Staging fixture restaurant missing (${STAGING_TEST_RESTAURANT_ID}). ` +
        'These tests require the staging Supabase project (mdqjpxwczrhkxkbqatqa), not production.',
    )
  }

  const { data: existingMembers, error: listError } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', STAGING_TEST_EMAIL)
    .order('created_at', { ascending: true })

  if (listError) throw listError

  if (existingMembers?.length) {
    const keepId = String(existingMembers[0].id)
    const extraIds = existingMembers.slice(1).map((row) => String(row.id))
    if (extraIds.length > 0) {
      const { error: permError } = await admin.from('staff_permissions').delete().in('staff_id', extraIds)
      if (permError) throw permError
      const { error: memberError } = await admin.from('staff_members').delete().in('id', extraIds)
      if (memberError) throw memberError
    }
    return keepId
  }

  const { data: inserted, error } = await admin
    .from('staff_members')
    .insert({
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      email: STAGING_TEST_EMAIL,
      role: STAGING_TEST_ROLE,
      active: true,
    })
    .select('id')
    .single()

  if (error) throw error
  return String(inserted.id)
}

export async function cleanupStagingStaffMember(admin: SupabaseClient, staffMemberId: string): Promise<void> {
  const { error: permError } = await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
  if (permError) throw permError
  const { error: memberError } = await admin.from('staff_members').delete().eq('id', staffMemberId)
  if (memberError) throw memberError
}

export async function clearStagingStaffPermissionOverrides(
  admin: SupabaseClient,
  staffMemberId: string,
): Promise<void> {
  const { error } = await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
  if (error) throw error
}

export async function restoreRestaurantRoles(
  admin: SupabaseClient,
  restaurantId: string,
  backup: Array<Record<string, unknown>>,
): Promise<void> {
  const { error: deleteError } = await admin.from('restaurant_roles').delete().eq('restaurant_id', restaurantId)
  if (deleteError) throw deleteError
  if (backup.length === 0) return
  const { error: insertError } = await admin.from('restaurant_roles').insert(backup)
  if (insertError) throw insertError
}
