import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { assertTerminalPairedToStation, StationPairingMismatchError } from '@/lib/stations/station-pairing'
import { POST as bumpOrderLineState } from '@/app/api/station/order-lines/[lineId]/state/route'

export const dynamic = 'force-dynamic'

/**
 * feat/station-screens-v1 — the kitchen screen's two taps. Station marks a line Cooked; the
 * pass marks it Ready to run.
 *
 * ============================================================================================
 * FIXED 2026-08-28 — THIS ROUTE NO LONGER WRITES order_lines OR order_line_events ITSELF
 * ============================================================================================
 *
 * It used to, against a GUESSED schema (lib/stations/schema-assumptions.ts, now retired), and
 * carried two live defects because of it:
 *
 *   1. KITCHEN_STATE_BY_ACTION mapped the ACTION NAME 'ready_to_run' into the stored value, i.e.
 *      it wrote the literal string 'ready_to_run' into kitchen_state. The real vocabulary
 *      (lib/orders/order-lines.ts) has no such state — it is 'ready' — so that write 500'd
 *      against order_lines_kitchen_state_check the moment 'cooked' also became reachable in
 *      production. 'cooked' the action happened to spell the same as 'cooked' the state, which is
 *      the only reason that half ever looked like it worked.
 *   2. The order_line_events insert used event_type/created_at/created_by. The real table
 *      (20260827131100_order_line_events.sql) has from_state/to_state/actor_kind/actor_user_id/
 *      occurred_at. The insert error was caught and logged, never surfaced, so every bump looked
 *      successful while writing zero audit rows.
 *
 * The fix is not two column-name patches. This route now does ONLY its own job — translate its
 * own `action` vocabulary and enforce the screen-pairing gate — and delegates the actual write to
 * POST /api/station/order-lines/[lineId]/state, in-process, which already does the conditional
 * update AND the atomic audit-event write for both of them, and would have refused
 * 'ready_to_run' at the door with a readable 400 instead of a swallowed-error 200. One writer for
 * order_lines and order_line_events, not two independently-guessed ones.
 *
 * 'done' is NOT in ACTION_TO_STATE. This route's own action vocabulary is 'cooked' |
 * 'ready_to_run' (the kitchen screen's two button labels) and stays that way; the delegate
 * separately accepts 'done' as ITS OWN legacy alias for callers that speak the state vocabulary
 * directly, which this route does not.
 */
const ACTION_TO_STATE = {
  cooked: 'cooked',
  ready_to_run: 'ready',
} as const

type Action = keyof typeof ACTION_TO_STATE

export async function POST(req: Request, ctx: { params: Promise<{ lineId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Station screens are not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    try {
      await assertTerminalPairedToStation(supabase, terminal, 'kitchen')
    } catch (err) {
      if (err instanceof StationPairingMismatchError) {
        return NextResponse.json({ error: err.message, code: err.code, pairedTo: err.pairedTo }, { status: 403 })
      }
      throw err
    }

    const body = (await req.json().catch(() => ({}))) as { action?: string }
    if (!body.action || !(body.action in ACTION_TO_STATE)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    const to_state = ACTION_TO_STATE[body.action as Action]

    // Delegate to the real contract: same terminal token (same Authorization header), the
    // station and to_state it actually expects. In-process, not a network round trip.
    const delegateReq = new Request(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify({ station: 'kitchen', to_state }),
    })

    return bumpOrderLineState(delegateReq, ctx)
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[station-lines/:lineId] failed:', err)
    return NextResponse.json({ error: 'Failed to record the line event' }, { status: 500 })
  }
}
