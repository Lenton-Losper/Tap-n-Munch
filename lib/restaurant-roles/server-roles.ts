import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { isStaffAssignableRole } from '@/lib/restaurant-roles/assignable'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export async function resolveStaffAssignableRoleSlug(
  supabase: Supabase,
  restaurantId: string,
  roleInput: string,
): Promise<string | null> {
  const roleSlug = String(roleInput || '').trim().toLowerCase()
  if (!roleSlug) return null

  const { data, error } = await supabase
    .from('restaurant_roles')
    .select('role_slug, is_system')
    .eq('restaurant_id', restaurantId)
    .eq('role_slug', roleSlug)
    .maybeSingle()

  if (error) throw error
  if (!data || !isStaffAssignableRole(data)) return null
  return data.role_slug
}

export async function resolveInviteEligibleRoleSlug(
  supabase: Supabase,
  restaurantId: string,
  roleInput: string,
): Promise<string | null> {
  const roleSlug = String(roleInput || '').trim().toLowerCase()
  if (!roleSlug) return null

  const { data, error } = await supabase
    .from('restaurant_roles')
    .select('role_slug, is_invite_eligible')
    .eq('restaurant_id', restaurantId)
    .eq('role_slug', roleSlug)
    .eq('is_invite_eligible', true)
    .maybeSingle()

  if (error) throw error
  return data?.role_slug ?? null
}
