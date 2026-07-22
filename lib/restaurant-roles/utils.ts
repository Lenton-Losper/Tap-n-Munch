import { PERMISSIONS, type Permission } from '@/lib/permissions'

const KNOWN_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS))

export function slugifyRoleDisplayName(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 64)

  return base || 'custom_role'
}

/**
 * Drops unrecognized permission strings instead of rejecting the whole array. Some
 * restaurant_roles rows carry legacy values (e.g. "orders:amend", "orders:refund") from
 * before the permission model settled on its current naming -- those are dead data (no code
 * checks for them), and round-tripping a role's existing permissions through an edit that
 * only touches one unrelated toggle should not fail just because old cruft is still attached.
 */
export function normalizePermissionsInput(value: unknown): Permission[] | null {
  if (!Array.isArray(value)) return null
  const perms = value.map((p) => String(p).trim()).filter(Boolean)
  const known = perms.filter((perm) => KNOWN_PERMISSIONS.has(perm))
  const unknown = perms.filter((perm) => !KNOWN_PERMISSIONS.has(perm))
  if (unknown.length > 0) {
    console.warn('[restaurant-roles] dropping unrecognized permission values', { unknown })
  }
  return [...new Set(known)] as Permission[]
}

export async function ensureUniqueRoleSlug(
  supabase: { from: (table: string) => any },
  restaurantId: string,
  desiredSlug: string,
): Promise<string> {
  let candidate = desiredSlug
  let suffix = 2
  while (true) {
    const { data, error } = await supabase
      .from('restaurant_roles')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('role_slug', candidate)
      .maybeSingle()
    if (error) throw error
    if (!data) return candidate
    candidate = `${desiredSlug}_${suffix}`
    suffix++
  }
}
