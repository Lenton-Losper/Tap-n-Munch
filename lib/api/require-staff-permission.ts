import { NextResponse } from 'next/server'
import { createServerSessionClient } from '@/lib/supabase/server-session'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
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
  } catch {
    return NextResponse.json(
      { error: 'Restaurant not found for this account.' },
      { status: 403 },
    )
  }

  const denied = await requirePermission(user.id, restaurantId, permission)
  if (denied) return denied

  return { userId: user.id, restaurantId, supabase }
}
