/**
 * Staff assignment vs invite eligibility (Phase 4B).
 *
 * Assignable in staff dropdown/PATCH: non-system roles except bar (bar was never
 * in ASSIGNABLE_ROLES; assigned via other paths in Phase 1).
 * Invite picker: is_invite_eligible on restaurant_roles.
 */

export type RestaurantRoleRef = {
  role_slug: string
  display_name?: string
  is_system: boolean
  is_invite_eligible?: boolean
}

export function isStaffAssignableRole(role: RestaurantRoleRef): boolean {
  if (role.is_system) return false
  if (role.role_slug === 'bar') return false
  return true
}

export function sortRolesForDisplay<T extends { display_name?: string; role_slug: string }>(
  roles: T[],
): T[] {
  return [...roles].sort((a, b) =>
    (a.display_name || a.role_slug).localeCompare(b.display_name || b.role_slug),
  )
}
