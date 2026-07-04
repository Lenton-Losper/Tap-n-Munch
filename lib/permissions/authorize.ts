import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ROLE_PERMISSIONS, Permission } from './index'
import { NextResponse } from 'next/server'

/**
 * staff_permissions.staff_id references staff_members.id (not users.id).
 * staff_members links to auth users by email + restaurant_id — there is no user_id column.
 */
export async function resolveStaffMemberId(
  userId: string,
  restaurantId: string,
): Promise<string | null> {
  const supabase = createServerSupabaseClient()

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('email')
    .eq('id', userId)
    .maybeSingle()

  if (userError) throw userError

  const email = String(userRow?.email || '').trim().toLowerCase()
  if (!email) return null

  const { data: member, error: memberError } = await supabase
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .ilike('email', email)
    .maybeSingle()

  if (memberError) throw memberError
  return member?.id ? String(member.id) : null
}

/**
 * Resolve a user's role for a given restaurant.
 * Checks restaurant_users table. Falls back to restaurants.owner_id.
 */
export async function getUserRole(
  userId: string,
  restaurantId: string
): Promise<string | null> {
  const supabase = createServerSupabaseClient()

  const { data: membership } = await supabase
    .from('restaurant_users')
    .select('role')
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (membership?.role) return membership.role

  // Fallback: check if user is the restaurant owner
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('owner_id')
    .eq('id', restaurantId)
    .maybeSingle()

  if (restaurant?.owner_id === userId) return 'owner'

  return null
}

/**
 * Check if a user has a specific permission for a restaurant.
 * 1. Resolves role from DB
 * 2. Applies default role permissions from code
 * 3. Applies per-user overrides from staff_permissions
 */
export async function authorize(
  userId: string,
  restaurantId: string,
  permission: Permission
): Promise<boolean> {
  const supabase = createServerSupabaseClient()

  const role = await getUserRole(userId, restaurantId)
  if (!role) return false

  // Get default permissions for this role
  const defaultPerms = ROLE_PERMISSIONS[role] ?? []
  let allowed = defaultPerms.includes(permission)

  // Apply per-user overrides from staff_permissions (keyed by staff_members.id)
  const staffMemberId = await resolveStaffMemberId(userId, restaurantId)
  if (staffMemberId) {
    const { data: overrides, error: overrideError } = await supabase
      .from('staff_permissions')
      .select('permission, effect')
      .eq('staff_id', staffMemberId)
      .eq('permission', permission)
      .eq('restaurant_id', restaurantId)

    if (overrideError) throw overrideError

    if (overrides && overrides.length > 0) {
      allowed = overrides[0].effect === 'allow'
    }
  }

  return allowed
}

/**
 * Require a permission or throw a 403 response.
 * Use in API route handlers.
 *
 * @example
 * const denied = await requirePermission(userId, restaurantId, PERMISSIONS.MENU_WRITE)
 * if (denied) return denied
 */
export async function requirePermission(
  userId: string,
  restaurantId: string,
  permission: Permission
): Promise<NextResponse | null> {
  const allowed = await authorize(userId, restaurantId, permission)
  if (!allowed) {
    return NextResponse.json(
      { error: 'You do not have permission to perform this action.' },
      { status: 403 }
    )
  }
  return null
}
