import { redirect } from 'next/navigation'
import { createServerSessionClient } from '@/lib/supabase/server-session'

export type StockOwnerContext = {
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>
  userId: string
  restaurantId: string
}

async function resolveOwnerRestaurantId(
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>,
  userId: string,
): Promise<string | null> {
  const { data: membership, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id, role')
    .eq('user_id', userId)
    .eq('role', 'owner')
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

export async function requireStockOwner(): Promise<StockOwnerContext> {
  const supabase = await createServerSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/signin')
  }

  const restaurantId = await resolveOwnerRestaurantId(supabase, user.id)
  if (!restaurantId) {
    redirect('/dashboard')
  }

  return { supabase, userId: user.id, restaurantId }
}
