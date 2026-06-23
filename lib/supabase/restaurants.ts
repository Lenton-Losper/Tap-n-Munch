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

/** Look up a restaurant by its Supabase UUID (restaurants.id). */
export async function getRestaurantById(restaurantId: string) {
  const id = String(restaurantId || '').trim()
  if (!id) return null

  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name, phone, currency, owner_id, payment_methods, subscription_status, subscription_tier, logo_url, updated_at')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

/**
 * Legacy export name used by /menu/* routes (not updated in Phase 1).
 * Delegates to getRestaurantById — only Supabase UUID lookups are supported.
 */
export const getRestaurantByFirebaseId = getRestaurantById

export async function resolveRestaurantUuid(restaurantIdInput: string) {
  const id = String(restaurantIdInput || '').trim()
  if (!id) {
    throw new Error('Restaurant id is required')
  }
  if (isUuid(id)) return id

  const restaurant = await getRestaurantById(id)
  if (!restaurant?.id) {
    throw new Error(`Restaurant not found for id=${id}`)
  }
  return String(restaurant.id)
}

export type OrderRestaurantScope = {
  restaurantId: string
  /** @deprecated Use restaurantId — kept for order API routes not updated in Phase 1 */
  firebaseRestaurantId: string
}

export async function resolveOrderRestaurantScope(
  restaurantIdInput: string
): Promise<OrderRestaurantScope> {
  const restaurantId = await resolveRestaurantUuid(restaurantIdInput)
  return { restaurantId, firebaseRestaurantId: restaurantId }
}

export async function getRestaurant(restaurantIdInput: string) {
  const id = String(restaurantIdInput || '').trim()
  if (!id) return null

  if (isUuid(id)) {
    const { data, error } = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data
  }

  const resolvedId = await resolveRestaurantUuid(id).catch(() => null)
  if (!resolvedId) return null
  return getRestaurantById(resolvedId)
}

export async function updateRestaurantSettings(
  restaurantIdInput: string,
  updates: Record<string, any>
) {
  if (typeof window !== 'undefined') {
    const response = await fetch('/api/admin/restaurant-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: restaurantIdInput, updates }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to update restaurant settings')
    }
    return payload?.data
  }

  const restaurantId = await resolveRestaurantUuid(restaurantIdInput)
  const { error } = await supabase
    .from('restaurants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', restaurantId)
  if (error) throw error
}
