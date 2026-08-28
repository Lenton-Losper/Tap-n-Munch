import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'
import { isStationKind, type StationKind } from '@/lib/stations/station-pairing'
import { STATION_PAIRING_COPY } from '@/lib/stations/pairing-copy'

export const dynamic = 'force-dynamic'

function statusCode(message: string): number {
  return message.includes('authorization') || message.includes('session')
    ? 401
    : message.includes('permission')
      ? 403
      : 500
}

/**
 * List paired station screens for this restaurant. NEVER selects activation_code -- the code is
 * shown once, at creation, and this list is the read path that must not resurrect it. See
 * lib/stations/pairing-copy.ts's docblock.
 */
export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.TERMINAL_AUTH_MANAGE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select(
        'id, terminal_name, station_kind, status, active, activated_at, last_seen_at, activation_code_expires_at, created_at',
      )
      .eq('restaurant_id', restaurantId)
      .not('station_kind', 'is', null)
      .order('created_at', { ascending: false })

    if (error) throw error

    const now = Date.now()
    const screens = (data ?? []).map((row) => {
      const codeExpiresAt = row.activation_code_expires_at ? String(row.activation_code_expires_at) : null
      return {
        id: row.id,
        name: row.terminal_name || STATION_PAIRING_COPY.defaultName[row.station_kind as StationKind],
        station: row.station_kind,
        status: row.status,
        active: row.active,
        activatedAt: row.activated_at,
        lastSeenAt: row.last_seen_at,
        hasPendingCode: Boolean(codeExpiresAt && new Date(codeExpiresAt).getTime() > now),
        codeExpiresAt,
      }
    })

    return NextResponse.json({ screens })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load paired screens'
    return NextResponse.json({ error: message }, { status: statusCode(message) })
  }
}

/** Pair a new screen: create the terminal row and issue its one-time activation code. */
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.TERMINAL_AUTH_MANAGE)
    if (denied) return denied

    const body = (await request.json().catch(() => ({}))) as { station?: unknown; name?: unknown }
    const station = String(body.station ?? '').trim().toLowerCase()
    if (!isStationKind(station)) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }

    const name = String(body.name ?? '').trim() || STATION_PAIRING_COPY.defaultName[station]
    const activationCode = generateTerminalActivationCode()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const { data: terminal, error } = await supabase
      .from('restaurant_terminals')
      .insert({
        restaurant_id: restaurantId,
        device_serial: null,
        activation_code: activationCode,
        activation_code_expires_at: expiresAt,
        status: 'pending',
        active: false,
        terminal_name: name,
        station_kind: station,
      })
      .select('id')
      .single()

    if (error) throw error

    // Returned exactly once, by this response, to the manager who just generated it.
    return NextResponse.json({
      id: terminal.id,
      name,
      station,
      activationCode,
      expiresAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to pair screen'
    return NextResponse.json({ error: message }, { status: statusCode(message) })
  }
}
