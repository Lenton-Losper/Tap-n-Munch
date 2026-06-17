import { createServerSupabaseClient } from './server'
import { supabase } from './client'

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

const RESTAURANT_ORDER_SCOPE_SELECT = 'id, firebase_id'

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
      .select(RESTAURANT_ORDER_SCOPE_SELECT)
      .eq('id', firebaseRestaurantId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('restaurants')
    .select(RESTAURANT_ORDER_SCOPE_SELECT)
    .eq('firebase_restaurant_id', firebaseRestaurantId)
    .maybeSingle()

  // Some environments don't have firebase_restaurant_id anymore; fall back to id lookup.
  if (error && String((error as any).message || '').includes('firebase_restaurant_id')) {
    const fallback = await supabase
      .from('restaurants')
      .select(RESTAURANT_ORDER_SCOPE_SELECT)
      .eq('id', firebaseRestaurantId)
      .maybeSingle()
    if (fallback.error) throw fallback.error
    return fallback.data
  }
  if (error) throw error
  if (data) return data

  const byFirebaseId = await supabase
    .from('restaurants')
    .select(RESTAURANT_ORDER_SCOPE_SELECT)
    .eq('firebase_id', firebaseRestaurantId)
    .maybeSingle()
  if (byFirebaseId.error && !String((byFirebaseId.error as any).message || '').includes('firebase_id')) {
    throw byFirebaseId.error
  }
  return byFirebaseId.data
}

export async function resolveRestaurantUuid(firebaseRestaurantId: string) {
  if (isUuid(firebaseRestaurantId)) return firebaseRestaurantId
  const restaurant = await getRestaurantByFirebaseId(firebaseRestaurantId)
  if (!restaurant?.id) {
    throw new Error(`Restaurant not found for id=${firebaseRestaurantId}`)
  }
  return restaurant.id as string
}

export type OrderRestaurantScope = {
  input: string
  supabaseUuid: string
  firebaseRestaurantId: string
}

/** Read the value stored on orders.firebase_restaurant_id for this restaurant. */
export function extractFirebaseRestaurantId(
  restaurant: Record<string, unknown> | null | undefined
): string {
  if (!restaurant) return ''
  const explicit = String(restaurant.firebase_id || restaurant.firebase_restaurant_id || '').trim()
  if (explicit) return explicit
  // Migrated restaurants (e.g. Riviera) may key orders by Supabase UUID when firebase_id is unset.
  return String(restaurant.id || '').trim()
}

export function buildOrderRestaurantScopeFromRestaurant(
  restaurant: Record<string, unknown>,
  inputId = ''
): OrderRestaurantScope {
  const supabaseUuid = String(restaurant.id || '').trim()
  const firebaseRestaurantId = extractFirebaseRestaurantId(restaurant)
  if (!supabaseUuid || !firebaseRestaurantId) {
    throw new Error('Restaurant record missing id or firebase_id')
  }
  return {
    input: inputId || supabaseUuid,
    supabaseUuid,
    firebaseRestaurantId,
  }
}

/** Resolve how orders are keyed in Supabase (firebase_restaurant_id on orders rows). */
export async function resolveOrderRestaurantScope(
  restaurantIdInput: string,
  options?: { firebaseRestaurantId?: string | null }
): Promise<OrderRestaurantScope> {
  const hintedFirebaseId = String(options?.firebaseRestaurantId || '').trim()
  const restaurant = await getRestaurantByFirebaseId(restaurantIdInput)
  if (!restaurant?.id) {
    throw new Error(`Restaurant not found for id=${restaurantIdInput}`)
  }
  const supabaseUuid = String(restaurant.id)
  const row = restaurant as Record<string, unknown>
  const firebaseRestaurantId =
    hintedFirebaseId ||
    extractFirebaseRestaurantId(row) ||
    (!isUuid(restaurantIdInput) ? restaurantIdInput.trim() : supabaseUuid)

  if (!firebaseRestaurantId) {
    throw new Error(
      `Restaurant ${supabaseUuid} is missing firebase_id — orders are keyed by firebase_restaurant_id, not Supabase UUID`
    )
  }

  const scope: OrderRestaurantScope = {
    input: restaurantIdInput,
    supabaseUuid,
    firebaseRestaurantId,
  }
  return scope
}

/** PostgREST OR filter for orders keyed by Firebase UID and/or Supabase restaurant UUID. */
export function orderRestaurantOrFilter(scope: OrderRestaurantScope): string {
  return `firebase_restaurant_id.eq.${scope.firebaseRestaurantId},restaurant_id.eq.${scope.supabaseUuid}`
}

export function orderRestaurantFirebaseId(scope: OrderRestaurantScope): string {
  return scope.firebaseRestaurantId
}

export async function getRestaurant(restaurantIdInput: string) {
  const id = String(restaurantIdInput || '').trim()
  if (!id) return null

  const fetchFullRow = async (restaurantUuid: string) => {
    const { data, error } = await supabase
      .from('restaurants')
      .select('*')
      .eq('id', restaurantUuid)
      .maybeSingle()
    if (error) throw error
    return data
  }

  if (isUuid(id)) {
    return fetchFullRow(id)
  }

  const scoped = await getRestaurantByFirebaseId(id)
  if (scoped?.id) {
    return fetchFullRow(String(scoped.id))
  }
  return scoped
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
