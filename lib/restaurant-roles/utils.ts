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

export function normalizePermissionsInput(value: unknown): Permission[] | null {
  if (!Array.isArray(value)) return null
  const perms = value.map((p) => String(p).trim()).filter(Boolean)
  if (perms.length === 0) return []
  for (const perm of perms) {
    if (!KNOWN_PERMISSIONS.has(perm)) return null
  }
  return [...new Set(perms)] as Permission[]
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
