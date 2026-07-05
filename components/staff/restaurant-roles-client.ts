import { getAccessToken } from '@/lib/onboarding/api-client'
import { isStaffAssignableRole } from '@/lib/restaurant-roles/assignable'

export type RestaurantRoleOption = {
  role_slug: string
  display_name: string
  is_system: boolean
  is_invite_eligible: boolean
}

export async function fetchRestaurantRoles(): Promise<RestaurantRoleOption[]> {
  const token = await getAccessToken()
  const res = await fetch('/api/admin/restaurant-roles', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error('Failed to load restaurant roles')
  }
  const data = await res.json()
  return (data.roles ?? []) as RestaurantRoleOption[]
}

export function filterStaffAssignableRoles(roles: RestaurantRoleOption[]): RestaurantRoleOption[] {
  return roles
    .filter(isStaffAssignableRole)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
}

export function filterInviteEligibleRoles(roles: RestaurantRoleOption[]): RestaurantRoleOption[] {
  return roles
    .filter((r) => r.is_invite_eligible)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
}
