import { redirect } from 'next/navigation'
import { authorize } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'
import { createServerSessionClient } from '@/lib/supabase/server-session'
import { pickSessionRestaurant } from '@/lib/auth/pick-session-restaurant'

export type SettingsAccessContext = {
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>
  userId: string
  restaurantId: string
}

/**
 * Settings must land on the SAME restaurant the dashboard did.
 *
 * This used to take `.limit(1)` off restaurant_users with no ORDER BY, while /api/auth/role
 * resolved through pickSessionRestaurant. For a single-restaurant account the two always agreed
 * and the difference was invisible. For a multi-restaurant one they could disagree outright --
 * and Settings is where Business & Locations lives, so switching location and opening Settings
 * was the fastest way to see two answers to "which restaurant am I on".
 *
 * Same rule as the session bootstrap: the stored context is a PREFERENCE, honoured only when it
 * names a restaurant the user currently belongs to, never a grant. A read failure means "no
 * preference" and falls back -- a broken row must not lock anyone out of their own settings.
 */
async function resolveStaffRestaurantId(
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>,
  userId: string,
): Promise<string | null> {
  const { data: memberships, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id, role')
    .eq('user_id', userId)
    .is('deleted_at', null)

  if (membershipError) throw membershipError

  const memberRestaurantIds = (memberships ?? [])
    .slice()
    .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))
    .map((row) => String(row.restaurant_id))
    .filter(Boolean)

  let storedRestaurantId: string | null = null
  const { data: storedContext, error: storedError } = await supabase
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (storedError) {
    console.error('[settings/auth] user_active_context read failed, falling back:', storedError.message)
  } else if (storedContext?.context_type === 'restaurant' && storedContext.restaurant_id) {
    storedRestaurantId = String(storedContext.restaurant_id)
  }

  const picked = pickSessionRestaurant({ memberRestaurantIds, storedRestaurantId })
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
  if (restaurant?.id) {
    return String(restaurant.id)
  }

  return null
}

export async function getAuthenticatedSettingsContext(): Promise<
  SettingsAccessContext | { error: string }
> {
  const supabase = await createServerSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Sign in required.' }
  }

  const restaurantId = await resolveStaffRestaurantId(supabase, user.id)
  if (!restaurantId) {
    return { error: 'Restaurant not found for this account.' }
  }

  return { supabase, userId: user.id, restaurantId }
}

export async function requireSettingsPermission(
  permission: Permission,
): Promise<SettingsAccessContext> {
  const context = await getAuthenticatedSettingsContext()
  if ('error' in context) {
    redirect('/signin')
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    redirect('/dashboard')
  }

  return context
}

export async function requireSettingsPermissionOrError(
  permission: Permission,
): Promise<SettingsAccessContext | { error: string }> {
  const context = await getAuthenticatedSettingsContext()
  if ('error' in context) {
    return context
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    return { error: 'You do not have permission to perform this action.' }
  }

  return context
}
