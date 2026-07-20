import { NextResponse } from 'next/server'
import { createServerSessionClient } from '@/lib/supabase/server-session'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  AmbiguousRestaurantError,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { authorize, requirePermission } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'

export type StaffAuthContext = {
  userId: string
  restaurantId: string
  supabase: ReturnType<typeof createServerSupabaseClient>
}

export function isAuthError(
  result: StaffAuthContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse
}

async function resolveAuthenticatedUser(request?: Request) {
  const authHeader = request?.headers.get('authorization') || ''
  if (/^Bearer\s+/i.test(authHeader)) {
    const user = await getUserFromRequest(request!)
    return user
  }

  const supabase = await createServerSessionClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return null
  }

  return user
}

export async function requireStaffPermission(
  restaurantId: string,
  permission: Permission,
  request?: Request,
): Promise<StaffAuthContext | NextResponse> {
  const trimmed = String(restaurantId || '').trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }

  const user = await resolveAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const allowed = await authorize(user.id, trimmed, permission)
  if (!allowed) {
    return NextResponse.json(
      { error: 'You do not have permission to perform this action.' },
      { status: 403 },
    )
  }

  return { userId: user.id, restaurantId: trimmed, supabase: createServerSupabaseClient() }
}

/**
 * Authenticate the caller and authorize against their linked restaurant
 * (from session / Bearer), not a client-supplied restaurant id.
 */
export async function requireCallerRestaurantPermission(
  permission: Permission,
  request: Request,
): Promise<StaffAuthContext | NextResponse> {
  const user = await resolveAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const supabase = createServerSupabaseClient()
  let restaurantId: string
  try {
    restaurantId = await getRestaurantIdForUser(supabase, user.id)
  } catch (err) {
    if (err instanceof AmbiguousRestaurantError) {
      // Distinct from "no restaurant" (403 below): this account genuinely belongs to
      // multiple restaurants and this endpoint has no way to infer which one was meant --
      // it needs an explicit restaurantId, not a silently-guessed one.
      return NextResponse.json(
        { error: 'This account belongs to multiple restaurants. Specify a restaurantId.' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: 'Restaurant not found for this account.' },
      { status: 403 },
    )
  }

  const denied = await requirePermission(user.id, restaurantId, permission)
  if (denied) return denied

  return { userId: user.id, restaurantId, supabase }
}

/**
 * Authorize against the caller's restaurant and ensure the URL restaurant id
 * matches (after UUID resolution). Rejects cross-tenant URL manipulation.
 */
export async function requireUrlRestaurantPermission(
  urlRestaurantId: string,
  permission: Permission,
  request: Request,
): Promise<StaffAuthContext | NextResponse> {
  const auth = await requireCallerRestaurantPermission(permission, request)
  if (isAuthError(auth)) return auth

  const trimmed = String(urlRestaurantId || '').trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'Missing restaurant id' }, { status: 400 })
  }

  let resolvedUrlId: string
  try {
    resolvedUrlId = await resolveRestaurantUuid(trimmed)
  } catch {
    return NextResponse.json({ error: 'Invalid restaurant id' }, { status: 400 })
  }

  if (resolvedUrlId !== auth.restaurantId) {
    return NextResponse.json(
      { error: 'You do not have permission to access this restaurant.' },
      { status: 403 },
    )
  }

  return auth
}
