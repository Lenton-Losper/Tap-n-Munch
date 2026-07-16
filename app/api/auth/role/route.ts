import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { getUserPermissions, getUserRole } from '@/lib/permissions/authorize'
import { parseStaffRole } from '@/lib/permissions/staff-role'

export const dynamic = 'force-dynamic'

async function resolveRestaurantId(
  userId: string,
): Promise<string | null> {
  const supabase = createServerSupabaseClient()

  const { data: membership, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (membershipError) throw membershipError
  if (membership?.restaurant_id) {
    return String(membership.restaurant_id)
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id')
    .eq('owner_id', userId)
    .limit(1)
    .maybeSingle()

  if (restaurantError) throw restaurantError
  return restaurant?.id ? String(restaurant.id) : null
}

async function resolveIsPlatformAdmin(userId: string): Promise<boolean> {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.rpc('is_platform_admin', { p_user_id: userId })
  if (error) {
    console.error('[auth/role] is_platform_admin check failed:', error)
    return false
  }
  return data === true
}

export async function GET(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const [restaurantId, isPlatformAdmin] = await Promise.all([
      resolveRestaurantId(authUser.id),
      resolveIsPlatformAdmin(authUser.id),
    ])

    if (!restaurantId) {
      return NextResponse.json({
        role: null,
        restaurant_id: null,
        permissions: [],
        is_platform_admin: isPlatformAdmin,
      })
    }

    const [roleSlug, permissions] = await Promise.all([
      getUserRole(authUser.id, restaurantId),
      getUserPermissions(authUser.id, restaurantId),
    ])

    return NextResponse.json({
      role: parseStaffRole(roleSlug),
      restaurant_id: restaurantId,
      permissions,
      is_platform_admin: isPlatformAdmin,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
