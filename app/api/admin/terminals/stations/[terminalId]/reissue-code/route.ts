import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'

export const dynamic = 'force-dynamic'

/**
 * Reissue a code for an already-paired screen -- the fix for "token cleared, browser reset,
 * someone reopens the tab, the kitchen is blank." Same row, same name, same station_kind: only
 * the credential is fresh. Existing PROOF: the activation redemption query
 * (app/api/terminals/activate/route.ts) requires active = false, so this must flip the row back
 * out of active exactly like revoke does -- which means a screen that is CURRENTLY working stops
 * the moment this runs, same as revoke. The confirm dialog in front of this button says so; see
 * lib/stations/pairing-copy.ts's docblock for why that is not a footnote.
 */
export async function POST(request: Request, { params }: { params: Promise<{ terminalId: string }> }) {
  try {
    const user = await getUserFromRequest(request)
    const { terminalId } = await params
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.TERMINAL_AUTH_MANAGE)
    if (denied) return denied

    const { data: terminal, error: findError } = await supabase
      .from('restaurant_terminals')
      .select('id, terminal_name, station_kind')
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)
      .not('station_kind', 'is', null)
      .maybeSingle()

    if (findError) throw findError
    if (!terminal?.id) {
      return NextResponse.json({ error: 'Paired screen not found' }, { status: 404 })
    }

    const activationCode = generateTerminalActivationCode()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const { error: updateError } = await supabase
      .from('restaurant_terminals')
      .update({
        status: 'pending',
        active: false,
        activation_code: activationCode,
        activation_code_expires_at: expiresAt,
        refresh_token_hash: null,
        refresh_token_expires_at: null,
      })
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)

    if (updateError) throw updateError

    // Returned exactly once, same as pairing a new screen.
    return NextResponse.json({
      id: terminal.id,
      name: terminal.terminal_name,
      station: terminal.station_kind,
      activationCode,
      expiresAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to reissue code'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
