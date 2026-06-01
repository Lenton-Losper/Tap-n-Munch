import { createServerSupabaseClient } from './server'
import { supabase } from './client'

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function createSupabaseRestaurant(data: {
  owner_id: string
  name: string
  phone: string
  currency?: string
}) {
  const supabase = createServerSupabaseClient()
  const { data: restaurant, error } = await supabase
    .from('restaurants')
    .insert({
      owner_id: data.owner_id,
      name: data.name,
      phone: data.phone,
      currency: data.currency || 'NAD',
      payment_methods: ['cash'],
      subscription_status: 'trial',
      subscription_tier: 'starter',
    })
    .select()
    .single()
  if (error) throw error
  return restaurant
}

export async function getSupabaseRestaurant(restaurantId: string) {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single()
  if (error) throw error
  return data
}

export async function updateSupabaseRestaurant(
  restaurantId: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('restaurants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', restaurantId)
  if (error) throw error
}

export async function getRestaurantByFirebaseId(firebaseRestaurantId: string) {
  // Most current routes pass Supabase UUID directly.
  if (isUuid(firebaseRestaurantId)) {
    const { data, error } = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', firebaseRestaurantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('firebase_restaurant_id', firebaseRestaurantId)
    .maybeSingle()

  // Some environments don't have firebase_restaurant_id anymore; fall back to id lookup.
  if (error && String((error as any).message || '').includes('firebase_restaurant_id')) {
    const fallback = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', firebaseRestaurantId)
      .maybeSingle()
    if (fallback.error) throw fallback.error
    return fallback.data
  }
  if (error) throw error
  return data
}

export async function resolveRestaurantUuid(firebaseRestaurantId: string) {
  if (isUuid(firebaseRestaurantId)) return firebaseRestaurantId
  const restaurant = await getRestaurantByFirebaseId(firebaseRestaurantId)
  if (!restaurant?.id) {
    throw new Error(`Restaurant not found for id=${firebaseRestaurantId}`)
  }
  return restaurant.id as string
}

export async function getRestaurant(firebaseRestaurantId: string) {
  return getRestaurantByFirebaseId(firebaseRestaurantId)
}

export async function updateRestaurantSettings(
  firebaseRestaurantId: string,
  updates: Record<string, any>
) {
  if (typeof window !== 'undefined') {
    const response = await fetch('/api/admin/restaurant-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: firebaseRestaurantId, updates }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to update restaurant settings')
    }
    return payload?.data
  }

  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  const { error } = await supabase
    .from('restaurants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', restaurantId)
  if (error) throw error
}
