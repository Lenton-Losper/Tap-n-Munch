import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from './server'
import { resolveSessionRestaurantId } from '@/lib/auth/resolve-session-restaurant'

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
    .is('deleted_at', null)

  if (error) throw error
  const rows = data ?? []
  // Owner rows first (stable, deterministic tie-break for callers that only look at [0]),
  // otherwise insertion order from the query.
  rows.sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))
  return rows.map((row) => String(row.restaurant_id))
}

/**
 * Resolves THE RESTAURANT THIS SESSION IS ON. Throws only when the user has access to none.
 *
 * REVERSES A WS1 RULING, DELIBERATELY. This used to throw AmbiguousRestaurantError for anyone
 * holding two memberships, and scripts/verify-ws1-tenancy-foundation-staging.ts asserted that it
 * did -- "not a silent arbitrary pick". That ruling was correct when it was made: there was no
 * principled way to choose, so refusing beat guessing.
 *
 * The premise stopped being true on 2026-08-19. #321 gave the product a stored, server-validated
 * active restaurant, and there is now a switcher to set it. Resolving to the user's OWN CURRENT
 * SELECTION is not an arbitrary pick, which is the only thing the ruling forbade.
 *
 * The cost of keeping the refusal was not theoretical: on production, Order History rendered
 * "This account belongs to multiple restaurants. Specify a restaurantId." to the account owner,
 * and ~24 call sites across payments, terminals, staff, invites and menu either showed that or
 * returned a 500. Every one of them broke the moment an owner gained a second location.
 *
 * Single-restaurant accounts are unaffected: with one membership, resolveSessionRestaurantId
 * returns that one membership whatever is stored, which is byte-identical to the old
 * restaurantIds[0]. That is the control that matters, because it is every ChowNow staff member.
 */
export async function getRestaurantIdForUser(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string
): Promise<string> {
  const restaurantId = await resolveSessionRestaurantId(supabase, userId)
  if (!restaurantId) {
    throw new Error('Restaurant not found for this account')
  }
  return restaurantId
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
