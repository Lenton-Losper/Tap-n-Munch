import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

/**
 * Revoke a paired screen. Sets BOTH status='revoked' (what validateTerminalRecord checks on
 * every authenticated request, lib/terminal-auth.ts) and active=false (what the activation
 * redemption query checks, app/api/terminals/activate/route.ts) -- the two flags are written
 * together everywhere else in this table for the same reason. Clears the refresh token so an
 * already-issued refresh cannot silently keep the old session alive past this call, and clears
 * any live activation code so a leaked/overheard code cannot redeem after the fact.
 *
 * This is DELIBERATELY not a DELETE. The row (and its last_seen_at / activated_at history) stays
 * so a manager can see when a screen was revoked and re-pair the same named row later via
 * reissue-code, rather than every re-pair creating an orphan.
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

    const { error: updateError } = await supabase
      .from('restaurant_terminals')
      .update({
        status: 'revoked',
        active: false,
        activation_code: null,
        activation_code_expires_at: null,
        refresh_token_hash: null,
        refresh_token_expires_at: null,
      })
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)

    if (updateError) throw updateError

    return NextResponse.json({ success: true, name: terminal.terminal_name })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to revoke screen'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
