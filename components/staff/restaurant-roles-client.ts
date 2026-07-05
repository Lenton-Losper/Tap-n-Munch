import { getAccessToken } from '@/lib/onboarding/api-client'
import { isStaffAssignableRole } from '@/lib/restaurant-roles/assignable'
import type { Permission } from '@/lib/permissions'

export type RestaurantRole = {
  id: string
  role_slug: string
  display_name: string
  permissions: string[]
  is_system: boolean
  is_invite_eligible: boolean
  assigned_count?: number
  created_at?: string
  updated_at?: string
}

export type RestaurantRoleOption = Pick<
  RestaurantRole,
  'role_slug' | 'display_name' | 'is_system' | 'is_invite_eligible'
>

async function authHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken()
  return { Authorization: `Bearer ${token}` }
}

export async function fetchRestaurantRoles(): Promise<RestaurantRole[]> {
  const res = await fetch('/api/admin/restaurant-roles', {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    throw new Error('Failed to load restaurant roles')
  }
  const data = await res.json()
  return (data.roles ?? []) as RestaurantRole[]
}

export async function createRestaurantRole(body: {
  display_name: string
  permissions: Permission[]
  is_invite_eligible?: boolean
}): Promise<RestaurantRole> {
  const res = await fetch('/api/admin/restaurant-roles', {
    method: 'POST',
    headers: {
      ...(await authHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || 'Failed to create role')
  }
  return data.role as RestaurantRole
}

export async function updateRestaurantRole(
  roleSlug: string,
  body: {
    display_name?: string
    permissions?: Permission[]
    is_invite_eligible?: boolean
  },
): Promise<RestaurantRole> {
  const res = await fetch(`/api/admin/restaurant-roles/${encodeURIComponent(roleSlug)}`, {
    method: 'PATCH',
    headers: {
      ...(await authHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || 'Failed to update role')
  }
  return data.role as RestaurantRole
}

export async function deleteRestaurantRole(roleSlug: string): Promise<void> {
  const res = await fetch(`/api/admin/restaurant-roles/${encodeURIComponent(roleSlug)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || 'Failed to delete role')
  }
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
