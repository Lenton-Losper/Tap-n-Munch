import { createServerSupabaseClient } from '@/lib/supabase/server'
import { RestaurantFeatures } from '@/contexts/feature-context'

export async function getRestaurantFeatures(restaurantId: string): Promise<RestaurantFeatures | null> {
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('restaurant_features')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  return data as RestaurantFeatures | null
}

export async function requireFeature(
  restaurantId: string,
  feature: keyof RestaurantFeatures
): Promise<{ allowed: boolean }> {
  const features = await getRestaurantFeatures(restaurantId)
  if (!features) return { allowed: false }
  return { allowed: features[feature] === true }
}
