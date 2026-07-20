import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
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

/** Thrown by getRestaurantIdForUser when the caller belongs to more than one restaurant and
 *  the endpoint has no way to disambiguate which one was meant. Callers that CAN accept a
 *  set should use getRestaurantIdsForUser instead. */
export class AmbiguousRestaurantError extends Error {
  readonly restaurantIds: string[]
  constructor(restaurantIds: string[]) {
    super('This account belongs to multiple restaurants; this action requires an explicit restaurantId.')
    this.name = 'AmbiguousRestaurantError'
    this.restaurantIds = restaurantIds
  }
}

/** Every restaurant_id the user belongs to (restaurant_users), in no particular guaranteed
 *  order beyond "owner rows first" -- use this instead of getRestaurantIdForUser wherever a
 *  caller can legitimately handle 0, 1, or many restaurants. */
export async function getRestaurantIdsForUser(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('restaurant_users')
    .select('restaurant_id, role')
    .eq('user_id', userId)

  if (error) throw error
  const rows = data ?? []
  // Owner rows first (stable, deterministic tie-break for callers that only look at [0]),
  // otherwise insertion order from the query.
  rows.sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))
  return rows.map((row) => String(row.restaurant_id))
}

/**
 * Resolves the SINGLE restaurant a user belongs to. Throws if the user belongs to zero
 * restaurants (unchanged from prior behavior), and throws AmbiguousRestaurantError if the
 * user belongs to more than one -- previously this silently picked one via a non-deterministic
 * `.limit(1)`, which is a real cross-tenant risk once a user can have multiple memberships.
 * Callers that can accept a set instead of forcing disambiguation should call
 * getRestaurantIdsForUser directly.
 */
export async function getRestaurantIdForUser(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<string> {
  const restaurantIds = await getRestaurantIdsForUser(supabase, userId)
  if (restaurantIds.length === 0) {
    throw new Error('Restaurant not found for this account')
  }
  if (restaurantIds.length > 1) {
    throw new AmbiguousRestaurantError(restaurantIds)
  }
  return restaurantIds[0]
}

/**
 * Ensures a requested restaurant id is one the caller actually belongs to.
 * Returns 403 on mismatch (does not substitute the caller's id silently).
 * Membership is checked against the caller's full restaurant set, so this works correctly
 * for a user belonging to more than one restaurant -- unlike getRestaurantIdForUser, this
 * never needs to throw an ambiguity error, since the caller already told us which
 * restaurant they mean; we just confirm they're actually a member of it.
 */
export async function requireCallerRestaurantId(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
  requestedRestaurantId: string,
): Promise<string | NextResponse> {
  const callerRestaurantIds = await getRestaurantIdsForUser(supabase, userId)
  if (callerRestaurantIds.length === 0) {
    return NextResponse.json({ error: 'Restaurant not found for this account' }, { status: 403 })
  }
  let resolvedRequestedId: string
  try {
    resolvedRequestedId = await resolveRestaurantId(supabase, requestedRestaurantId.trim())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Restaurant not found'
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    throw err
  }
  if (!callerRestaurantIds.includes(resolvedRequestedId)) {
    return NextResponse.json(
      { error: 'You do not have permission to perform this action.' },
      { status: 403 },
    )
  }
  return resolvedRequestedId
}
