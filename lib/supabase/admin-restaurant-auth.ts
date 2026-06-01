import { createClient } from '@supabase/supabase-js'
import { createServerSupabaseClient } from './server'

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function resolveRestaurantId(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  input: string
): Promise<string> {
  if (isUuid(input)) return input
  const { data, error } = await supabase
    .from('restaurants')
    .select('id')
    .eq('firebase_restaurant_id', input)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error('Restaurant not found')
  return data.id as string
}

export async function getUserFromRequest(request: Request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw new Error('Missing authorization. Sign in again.')
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured')
  }

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data.user) {
    throw new Error('Invalid or expired session. Sign in again.')
  }
  return data.user
}

/** Ensures the signed-in user may manage this restaurant (users.restaurant_id or restaurants.owner_id). */
export async function assertRestaurantAdmin(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
  restaurantId: string
): Promise<void> {
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('restaurant_id')
    .eq('id', userId)
    .maybeSingle()

  if (userError) throw userError

  if (String(userRow?.restaurant_id || '') === restaurantId) {
    return
  }

  const { data: restaurant, error: restError } = await supabase
    .from('restaurants')
    .select('owner_id')
    .eq('id', restaurantId)
    .maybeSingle()

  if (restError) throw restError

  const ownerId = restaurant?.owner_id != null ? String(restaurant.owner_id).trim() : ''
  if (ownerId && ownerId === userId) {
    return
  }

  throw new Error('You do not have permission to manage this restaurant.')
}
