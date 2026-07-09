import type { SupabaseClient } from '@supabase/supabase-js'
import { rolePermissionConfigEntries } from '@/lib/permissions/role-permissions-config'

const LOG_PREFIX = '[create-restaurant]'

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

const SYSTEM_ROLES = new Set(['owner'])

export type DefaultRestaurantRoleSeed = {
  role_slug: string
  display_name: string
  permissions: string[]
  is_system: boolean
}

export function buildDefaultRestaurantRolesSeed(): DefaultRestaurantRoleSeed[] {
  return rolePermissionConfigEntries().map(([roleSlug, permissions]) => ({
    role_slug: roleSlug,
    display_name: ROLE_DISPLAY_NAMES[roleSlug] ?? roleSlug,
    permissions: [...permissions],
    is_system: SYSTEM_ROLES.has(roleSlug),
  }))
}

export async function upsertPublicUserProfile(
  supabase: SupabaseClient,
  params: {
    id: string
    email: string | undefined
    fullName: string
    phone: string
  },
): Promise<void> {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        id: params.id,
        email: params.email,
        full_name: params.fullName,
        phone: params.phone || null,
      },
      { onConflict: 'id' },
    )
    .select('id')
    .maybeSingle()

  if (error) {
    console.error(LOG_PREFIX, 'public.users upsert failed', { userId: params.id, error })
    throw error
  }

  if (!data?.id) {
    const message = 'public.users upsert returned no row'
    console.error(LOG_PREFIX, message, { userId: params.id })
    throw new Error(message)
  }
}

export async function createRestaurantForUserAtomic(
  supabase: SupabaseClient,
  params: {
    userId: string
    email: string | undefined
    fullName: string
    phone: string
    restaurantName: string
  },
): Promise<string> {
  const rolesSeed = buildDefaultRestaurantRolesSeed()

  const { data: restaurantId, error } = await supabase.rpc('create_restaurant_for_user', {
    p_user_id: params.userId,
    p_email: params.email ?? null,
    p_full_name: params.fullName,
    p_phone: params.phone || null,
    p_restaurant_name: params.restaurantName,
    p_roles: rolesSeed,
  })

  if (error) {
    console.error(LOG_PREFIX, 'create_restaurant_for_user RPC failed', {
      userId: params.userId,
      restaurantName: params.restaurantName,
      error,
    })
    throw error
  }

  if (!restaurantId) {
    const message = 'create_restaurant_for_user returned no restaurant id'
    console.error(LOG_PREFIX, message, { userId: params.userId })
    throw new Error(message)
  }

  console.info(LOG_PREFIX, 'restaurant created atomically', {
    userId: params.userId,
    restaurantId,
    restaurantName: params.restaurantName,
  })

  return String(restaurantId)
}
