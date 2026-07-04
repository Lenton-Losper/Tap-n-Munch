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
  const { data: existingMember } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', STAGING_TEST_EMAIL)
    .maybeSingle()

  if (existingMember?.id) {
    return String(existingMember.id)
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
  await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
  await admin.from('staff_members').delete().eq('id', staffMemberId)
}
