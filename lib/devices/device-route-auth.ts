/**
 * Who is calling, which restaurant they are acting for, and which kinds of device they may manage.
 *
 * The restaurant is ALWAYS resolved from the caller's session (getRestaurantIdForUser), never read
 * from the request, so no body or path value can point a call at another venue.
 *
 * Kinds map to the permissions the existing routes already used, so nobody gains or loses access:
 *   payment terminals -> payments:configure (app/api/admin/terminals, generate-code, [terminalId])
 *   kitchen/bar       -> terminal:auth:manage (app/api/admin/terminals/stations/*)
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { authorize } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import type { DeviceKind } from '@/lib/devices/device-state'

export type DeviceCaller = {
  userId: string
  restaurantId: string
  supabase: ReturnType<typeof createServerSupabaseClient>
  canManage: Record<DeviceKind, boolean>
}

export async function resolveDeviceCaller(request: Request): Promise<DeviceCaller | NextResponse> {
  let user: { id: string }
  try {
    user = await getUserFromRequest(request)
  } catch {
    return NextResponse.json({ error: 'Sign in again to manage devices.' }, { status: 401 })
  }
  const supabase = createServerSupabaseClient()
  let restaurantId: string
  try {
    restaurantId = await getRestaurantIdForUser(supabase, user.id)
  } catch {
    return NextResponse.json({ error: 'No restaurant is linked to this account.' }, { status: 403 })
  }
  const [payments, screens] = await Promise.all([
    authorize(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE),
    authorize(user.id, restaurantId, PERMISSIONS.TERMINAL_AUTH_MANAGE),
  ])
  if (!payments && !screens) {
    return NextResponse.json({ error: 'You do not have permission to manage devices.' }, { status: 403 })
  }
  return {
    userId: user.id,
    restaurantId,
    supabase,
    canManage: { payment: Boolean(payments), kitchen: Boolean(screens), bar: Boolean(screens) },
  }
}

export function forbiddenForKind(kind: DeviceKind): NextResponse {
  return NextResponse.json(
    {
      error:
        kind === 'payment'
          ? 'You do not have permission to manage payment terminals.'
          : 'You do not have permission to manage kitchen and bar screens.',
    },
    { status: 403 },
  )
}
