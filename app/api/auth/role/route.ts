import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdsForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { getUserPermissions, getUserRole } from '@/lib/permissions/authorize'
import { parseStaffRole } from '@/lib/permissions/staff-role'
import { pickSessionRestaurant } from '@/lib/auth/pick-session-restaurant'

export const dynamic = 'force-dynamic'

/**
 * Resolves the restaurant to bootstrap the client session with. A bare `.maybeSingle()` on
 * restaurant_users used to live here and would throw (PGRST116) for any user belonging to
 * more than one restaurant -- getRestaurantIdsForUser is deterministic (owner rows first)
 * and never throws on multiple memberships.
 *
 * SINCE 2026-08-19 IT ALSO HONOURS THE STORED CONTEXT. The comment that used to sit here said
 * "There's no 'active restaurant' selector yet", and that was true of this route while being only
 * half true of the product: app/choose-context has always let a user pick, and written the choice
 * to user_active_context -- but nothing read it when deciding the session's restaurant, so
 * choosing changed where login landed you and never which restaurant you saw. The first
 * organisation to hold two restaurants made that the difference between reachable and not.
 *
 * The stored value is a PREFERENCE, re-validated against current memberships on every call by
 * pickSessionRestaurant. It can narrow the choice among restaurants the user already belongs to;
 * it can never add one.
 */
async function resolveRestaurantId(
  userId: string,
): Promise<string | null> {
  const supabase = createServerSupabaseClient()

  const restaurantIds = await getRestaurantIdsForUser(supabase, userId)

  // A missing row, a platform context, or a read failure all mean "no preference" -- never an
  // error, because a broken preference must not be able to lock a user out of their own session.
  let storedRestaurantId: string | null = null
  const { data: storedContext, error: storedError } = await supabase
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (storedError) {
    console.error('[auth/role] user_active_context read failed, falling back:', storedError.message)
  } else if (storedContext?.context_type === 'restaurant' && storedContext.restaurant_id) {
    storedRestaurantId = String(storedContext.restaurant_id)
  }

  const picked = pickSessionRestaurant({
    memberRestaurantIds: restaurantIds,
    storedRestaurantId,
  })
  if (picked.restaurantId) {
    return picked.restaurantId
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
