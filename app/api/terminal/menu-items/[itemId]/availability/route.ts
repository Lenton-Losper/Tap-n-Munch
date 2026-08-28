/**
 * POST /api/terminal/menu-items/{itemId}/availability
 *
 * A waiter marks a dish unavailable from the P5, and it disappears from every customer's menu at
 * that venue — QR and terminal — immediately.
 *
 * ============================================================================================
 * `hidden`, NOT `out_of_stock`. RULED 2026-08-28.
 * ============================================================================================
 *
 * `lib/menu/menu-item-status.ts` carries both:
 *
 *   out_of_stock : visible = true,  chargeable = false   -- shown, greyed, Add disabled
 *   hidden       : visible = false, chargeable = false   -- gone
 *
 * `out_of_stock` exists deliberately so a QR customer learns the dish exists. The owner's ruling
 * is that at a table-service venue that affordance is the wrong one: *"a greyed-out dish is an
 * argument with a waiter; a dish that is not there is nothing."* So this route writes `hidden`.
 *
 * It does NOT touch `out_of_stock`, and it must not: a venue that has deliberately greyed an item
 * has made a different decision, and restoring blindly to `available` would silently undo it. See
 * the restore branch.
 *
 * ============================================================================================
 * THE CACHE INVALIDATION IS NOT OPTIONAL AND IS THE WHOLE OF "IMMEDIATELY"
 * ============================================================================================
 *
 * The customer menu is served through `getCachedMenu` with a Redis TTL. Writing the status without
 * invalidating leaves the QR menu serving the dish until the TTL expires — the write succeeds, the
 * route returns 200, and the dish stays orderable on the surface the waiter was trying to change.
 *
 * That is the silent-degradation shape of #365 exactly, and it is why this happens on the write
 * path rather than being left to a sweep. `invalidateMenuCache` swallows its own Redis errors, so
 * a cache that is down cannot fail the write — but a cache that is UP must be cleared here.
 *
 * ============================================================================================
 * WHY A PIN
 * ============================================================================================
 *
 * The device is already authenticated, but a terminal token carries only orders:read,
 * orders:update and tables:read. This write is venue-wide — it changes what every customer in the
 * room can order — so it goes through the same single-use PIN authorization as opening a table,
 * with purpose `menu_availability` mapping to `menu:write`. See lib/terminal-auth/purpose-
 * permissions.ts for why the terminal token was not widened instead.
 *
 * PIN failures answer 403 with a code, never 401 — a 401 makes the device refresh its terminal
 * token and retry, which for a PIN problem is a loop that cannot succeed.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { invalidateMenuCache } from '@/lib/cache/menu-cache'
import {
  MENU_AVAILABILITY_AUDIT_REASON,
  MENU_AVAILABILITY_REFUSAL_COPY,
  type MenuAvailabilityRefusal,
} from '@/lib/menu/availability-copy'

export const dynamic = 'force-dynamic'

const MENU_AVAILABILITY_PURPOSE = 'menu_availability'
export const MENU_AVAILABILITY_ACTION = 'menu_item_availability_changed'

/** The status a waiter's "unavailable" writes, and the one it restores to. */
const HIDDEN_STATUS = 'hidden'
const RESTORED_STATUS = 'available'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    /**
     * The waiter's "mark unavailable" control ships behind the same flag as the rest of the P5
     * waiter flow, not server policy yet. Riviera-only was an accident of client version -- Mingle
     * and ChowNow are protected only by an old APK never calling this endpoint, not by anything
     * server-side. Added 2026-08-28.
     */
    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    const { itemId } = await params
    if (!itemId || !isUuid(itemId)) {
      return NextResponse.json({ error: 'itemId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      user_id?: unknown
      authorization_token_id?: unknown
      available?: unknown
    }
    const userId = String(body.user_id ?? '').trim()
    const tokenId = String(body.authorization_token_id ?? '').trim()
    const makeAvailable = body.available === true

    if (!isUuid(userId) || !isUuid(tokenId)) {
      return NextResponse.json(
        { error: 'user_id and authorization_token_id must be valid UUIDs' },
        { status: 400 },
      )
    }

    const refuse = (refusal: MenuAvailabilityRefusal, status = 409) =>
      NextResponse.json(
        { ok: false, refusal, message: MENU_AVAILABILITY_REFUSAL_COPY[refusal] },
        { status },
      )

    /**
     * The item is read and scoped BEFORE the token is consumed. The token is single-use, so
     * burning it on a bad id would make the waiter type their PIN again for our validation error.
     */
    const { data: item, error: itemError } = await supabase
      .from('menu_items')
      .select('id, restaurant_id, name, status')
      .eq('id', itemId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (itemError) throw itemError
    if (!item?.id) return refuse('item_not_found', 404)

    const currentStatus = String(item.status ?? '').trim().toLowerCase()
    const nextStatus = makeAvailable ? RESTORED_STATUS : HIDDEN_STATUS

    /**
     * Already there. Not an error — somebody else got to it first, which during a service is the
     * normal case rather than the exceptional one. Reported so the screen can say so instead of
     * claiming a change it did not make.
     */
    if (currentStatus === nextStatus) return refuse('already_in_that_state', 200)

    const consumed = await consumeAuthorizationToken(supabase, {
      tokenId,
      expectedUserId: userId,
      expectedRestaurantId: terminal.restaurantId,
      expectedTerminalId: terminal.terminalId,
      expectedPurpose: MENU_AVAILABILITY_PURPOSE,
    })
    if (!consumed.ok) return refuse('authorization_failed', 403)

    /**
     * CONDITIONAL ON THE STATUS WE READ. Two waiters pressing at once, or a manager editing on the
     * dashboard at the same moment, produce a second writer that matches zero rows rather than
     * overwriting a decision it never saw.
     */
    const { data: updated, error: updateError } = await supabase
      .from('menu_items')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('restaurant_id', terminal.restaurantId)
      .eq('status', item.status)
      .select('id, name, status')
      .maybeSingle()

    if (updateError) throw updateError
    if (!updated?.id) return refuse('already_in_that_state', 200)

    /**
     * THE INVALIDATION. See the header — without this the write lands and the QR menu keeps
     * serving the dish. It is awaited, not fired and forgotten, so the 200 means the customer
     * menu is already correct rather than about to be.
     */
    await invalidateMenuCache(terminal.restaurantId)

    await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      entity_type: 'menu_item',
      entity_id: itemId,
      action: MENU_AVAILABILITY_ACTION,
      metadata: {
        source: 'terminal_waiter_availability',
        requestedBy: userId,
        terminalId: terminal.terminalId,
        itemName: updated.name ?? null,
        previousStatus: item.status ?? null,
        newStatus: nextStatus,
        changedAt: new Date().toISOString(),
        reason: makeAvailable
          ? MENU_AVAILABILITY_AUDIT_REASON.restored
          : MENU_AVAILABILITY_AUDIT_REASON.hidden,
      },
    })

    return NextResponse.json({
      ok: true,
      item: { id: updated.id, name: updated.name, status: updated.status },
      hidden: !makeAvailable,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/menu-items/availability]', message)
    return NextResponse.json({ error: 'The menu could not be updated.' }, { status: 500 })
  }
}
