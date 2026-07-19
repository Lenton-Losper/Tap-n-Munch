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
 * Resolve default permissions for a role from restaurant_roles.
 * Falls back to static ROLE_PERMISSIONS when no DB row exists (seeding gap).
 */
export async function getRolePermissions(
  restaurantId: string,
  roleSlug: string,
): Promise<Permission[]> {
  const supabase = createServerSupabaseClient()

  const { data, error } = await supabase
    .from('restaurant_roles')
    .select('permissions')
    .eq('restaurant_id', restaurantId)
    .eq('role_slug', roleSlug)
    .maybeSingle()

  if (error) throw error

  if (data?.permissions) {
    return data.permissions as Permission[]
  }

  console.warn(
    `[authorize] restaurant_roles missing for restaurant=${restaurantId} role=${roleSlug}; falling back to static ROLE_PERMISSIONS`,
  )
  return ROLE_PERMISSIONS[roleSlug] ?? []
}

/**
 * Resolve the caller's full permission list for a restaurant.
 * 1. Resolves role from DB
 * 2. Applies default role permissions from restaurant_roles (JSON fallback)
 * 3. Applies per-user overrides from staff_permissions (allow adds, deny removes)
 */
export async function getUserPermissions(
  userId: string,
  restaurantId: string,
): Promise<Permission[]> {
  const role = await getUserRole(userId, restaurantId)
  if (!role) return []

  const granted = new Set<Permission>(await getRolePermissions(restaurantId, role))

  const staffMemberId = await resolveStaffMemberId(userId, restaurantId)
  if (!staffMemberId) {
    return [...granted]
  }

  const supabase = createServerSupabaseClient()
  const { data: overrides, error: overrideError } = await supabase
    .from('staff_permissions')
    .select('permission, effect')
    .eq('staff_id', staffMemberId)
    .eq('restaurant_id', restaurantId)

  if (overrideError) throw overrideError

  for (const row of overrides ?? []) {
    const perm = row.permission as Permission
    if (row.effect === 'allow') {
      granted.add(perm)
    } else if (row.effect === 'deny') {
      granted.delete(perm)
    }
  }

  return [...granted]
}

/**
 * Check if a user has a specific permission for a restaurant.
 */
export async function authorize(
  userId: string,
  restaurantId: string,
  permission: Permission
): Promise<boolean> {
  const permissions = await getUserPermissions(userId, restaurantId)
  return permissions.includes(permission)
}

/**
 * Organization-level permission (distinct namespace from restaurant Permission --
 * see PERMISSIONS.STOCK_TRANSFER_* for the location-internal counterparts).
 */
export type OrganizationPermission = 'view_all_locations' | 'create_cross_location_transfer'

/**
 * Check if a user has an organization-wide capability.
 *
 * Backed by organization_users -- in v1 this returns true only if the user has an
 * OWNER-role row for that organization_id. MEMBER rows return false for both
 * permissions in v1 (Workstream 2's role semantics: MEMBER is a placeholder for a
 * future non-owner org-level role, not wired to any capability yet).
 *
 * Deliberately does NOT fall back to restaurant_users -- belonging to a restaurant
 * inside the organization is not the same as holding organization-wide access, even
 * though today every organization happens to be 1:1 with a single restaurant. This
 * must go through organization_users explicitly, or it would silently grant
 * cross-location access the moment an organization gains a second restaurant.
 */
export async function authorizeOrganization(
  userId: string,
  organizationId: string,
  // v1 grants both permissions identically to OWNER (unused for now); kept as a
  // parameter so call sites are self-documenting and won't need to change shape
  // once a real MEMBER-level capability is introduced.
  permission: OrganizationPermission,
): Promise<boolean> {
  const supabase = createServerSupabaseClient()

  const { data, error } = await supabase
    .from('organization_users')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('role', 'OWNER')
    .maybeSingle()

  if (error) throw error

  return !!data
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
