import { redirect } from 'next/navigation'
import { authorize } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'
import { createServerSessionClient } from '@/lib/supabase/server-session'

export type StockAccessContext = {
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>
  userId: string
  restaurantId: string
}

async function resolveStaffRestaurantId(
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>,
  userId: string,
): Promise<string | null> {
  const { data: membership, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .limit(1)
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
  if (restaurant?.id) {
    return String(restaurant.id)
  }

  return null
}

export async function getAuthenticatedStockContext(): Promise<
  StockAccessContext | { error: string }
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

export async function requireStockPermission(
  permission: Permission,
): Promise<StockAccessContext> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) {
    redirect('/signin')
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    redirect('/dashboard')
  }

  return context
}

export async function requireStockPermissionOrError(
  permission: Permission,
): Promise<StockAccessContext | { error: string }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) {
    return context
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    return { error: 'You do not have permission to perform this action.' }
  }

  return context
}
