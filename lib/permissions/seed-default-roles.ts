import type { SupabaseClient } from '@supabase/supabase-js'
import { rolePermissionConfigEntries } from '@/lib/permissions/role-permissions-config'

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

const SYSTEM_ROLES = new Set(['owner'])

export async function seedDefaultRestaurantRoles(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  const rows = rolePermissionConfigEntries().map(([roleSlug, permissions]) => ({
    restaurant_id: restaurantId,
    role_slug: roleSlug,
    display_name: ROLE_DISPLAY_NAMES[roleSlug] ?? roleSlug,
    permissions: [...permissions],
    is_system: SYSTEM_ROLES.has(roleSlug),
  }))

  const { error } = await supabase
    .from('restaurant_roles')
    .upsert(rows, { onConflict: 'restaurant_id,role_slug', ignoreDuplicates: true })

  if (error) throw error
}
