/**
 * ADR-005 §1 and §5 -- a station bumps its own half of a line, and can un-bump it.
 *
 * ============================================================================================
 * THE STATE CHANGE AND ITS EVENT ARE WRITTEN TOGETHER, HERE
 * ============================================================================================
 *
 * The screens never write order_line_events themselves. If they did, the denormalised
 * kitchen_state/bar_state and the authoritative event log would be two writes by two clients that
 * can disagree, and the disagreement would be invisible.
 *
 * ============================================================================================
 * A CONDITIONAL UPDATE, SO from_state IS TRUE RATHER THAN ASSUMED
 * ============================================================================================
 *
 * The update is `.eq(column, expectedFrom)`. If it matches nothing, somebody else moved the line
 * between our read and our write -- two screens, or a screen racing the terminal's cancel -- and
 * this answers 409 with the current values rather than overwriting them.
 *
 * Recording a from_state we did not verify would put a fiction in an append-only audit table,
 * which is the one place a fiction cannot later be corrected by looking at the data.
 *
 * ============================================================================================
 * A STATION MAY WRITE 'cooked', 'ready', 'collected' AND 'outstanding'. IT MAY NOT WRITE 'voided'.
 * ============================================================================================
 *
 * Undo has to exist -- event Q, someone presses the wrong thing, and a mis-bumped line that
 * disappears from the pass is food that never gets made. Undo is this same endpoint with
 * to_state 'outstanding'.
 *
 * 'collected' (20260829160000) is the pass zone's own clear action -- a runner or waiter picking
 * up food that already reached 'ready'. Without it a pinned Ready zone never empties.
 *
 * 'voided' is not a station's to give. A void means the round was cancelled or amended at the
 * terminal, and letting a screen write it would let the kitchen silently delete a line the
 * customer is still being billed for.
 *
 * ============================================================================================
 * AUTH: see app/api/station/lines/route.ts. ADR-005 §8.1 is still unruled and changes how a
 * screen OBTAINS a credential, not this route's contract.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import {
  isLineReady,
  stationsOwnedBy,
  type LineRouteTo,
  type LineState,
  type Station,
} from '@/lib/orders/order-lines'

export const dynamic = 'force-dynamic'

/**
 * What a board may write. 'voided' is deliberately absent -- see the header.
 *
 *   cooked      -- the STATION has made it
 *   ready       -- the PASS has passed it
 *   collected   -- the pass zone was cleared; someone took it
 *   outstanding -- undo, from either
 *
 * 'done' is accepted as an INPUT ALIAS for 'ready' and is never stored. It was the old
 * vocabulary's terminal value, and translating it at the door means a board built against the
 * previous contract keeps working through this deploy instead of 400ing mid-service. One stored
 * meaning, no #349-shaped pair of values that can disagree.
 */
const STATION_WRITABLE_STATES = ['cooked', 'ready', 'collected', 'outstanding'] as const
type StationWritableState = (typeof STATION_WRITABLE_STATES)[number]

const LEGACY_STATE_ALIASES: Record<string, StationWritableState> = { done: 'ready' }

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isStation(value: string): value is Station {
  return value === 'kitchen' || value === 'bar'
}

function isWritableState(value: string): value is StationWritableState {
  return (STATION_WRITABLE_STATES as readonly string[]).includes(value)
}

export async function POST(req: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    /**
     * DEFENSE IN DEPTH -- see app/api/station/lines/route.ts's identical note. This route is a
     * bump the terminal wrapper routes (station-lines/[lineId], batch, bar-rounds/[roundId])
     * delegate to after their own feature-flag check, but it is also independently reachable
     * over HTTP with nothing but a valid terminal token. Found 2026-08-28 alongside the read side.
     */
    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Station screens are not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { lineId } = await params
    if (!lineId || !isUuid(lineId)) {
      return NextResponse.json({ error: 'lineId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      station?: unknown
      to_state?: unknown
    }
    const station = String(body.station ?? '').trim().toLowerCase()
    const rawToState = String(body.to_state ?? '').trim().toLowerCase()
    // Translate the retired vocabulary at the door, before validation, so a board on the old
    // contract is accepted rather than refused.
    const toState = LEGACY_STATE_ALIASES[rawToState] ?? rawToState

    if (!isStation(station)) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }
    if (!isWritableState(toState)) {
      return NextResponse.json(
        {
          error:
            "to_state must be 'cooked' (the station made it), 'ready' (the pass passed it), " +
            "'collected' (someone picked it up) or 'outstanding' (undo). A station cannot void a line.",
          code: 'INVALID_STATE',
        },
        { status: 400 },
      )
    }

    const stateColumn = station === 'kitchen' ? 'kitchen_state' : 'bar_state'

    const { data: line, error: lineError } = await supabase
      .from('order_lines')
      .select('id, restaurant_id, route_to, kitchen_state, bar_state')
      .eq('id', lineId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (lineError) throw lineError
    if (!line?.id) {
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    }

    const routeTo = line.route_to as LineRouteTo
    if (!stationsOwnedBy(routeTo).includes(station)) {
      return NextResponse.json(
        {
          error: `This line routes to '${routeTo}', so the ${station} does not own it.`,
          code: 'STATION_DOES_NOT_OWN_LINE',
          route_to: routeTo,
        },
        { status: 409 },
      )
    }

    const currentState = (station === 'kitchen' ? line.kitchen_state : line.bar_state) as LineState

    // A void came from the terminal cancelling or amending. A station must not resurrect it.
    if (currentState === 'voided') {
      return NextResponse.json(
        {
          error: 'This line was voided at the terminal and cannot be changed from a station.',
          code: 'LINE_VOIDED',
        },
        { status: 409 },
      )
    }

    // Already where the caller wants it: a double-tap, not an error. Report the line as it stands
    // and write nothing -- a second identical event would be noise in an append-only log.
    if (currentState === toState) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        line: {
          id: line.id,
          route_to: routeTo,
          kitchen_state: line.kitchen_state,
          bar_state: line.bar_state,
          is_ready: isLineReady(line),
        },
      })
    }

    // Conditional: only move it if it is still where we read it. See the header.
    const { data: updated, error: updateError } = await supabase
      .from('order_lines')
      .update({ [stateColumn]: toState })
      .eq('id', lineId)
      .eq('restaurant_id', terminal.restaurantId)
      .eq(stateColumn, currentState)
      .select('id, route_to, kitchen_state, bar_state')
      .maybeSingle()

    if (updateError) throw updateError

    if (!updated?.id) {
      // Somebody moved it underneath us. Answer with the truth rather than forcing our write.
      const { data: fresh } = await supabase
        .from('order_lines')
        .select('id, route_to, kitchen_state, bar_state')
        .eq('id', lineId)
        .maybeSingle()

      return NextResponse.json(
        {
          error: 'This line changed while you were looking at it.',
          code: 'LINE_CHANGED',
          line: fresh
            ? {
                id: fresh.id,
                route_to: fresh.route_to,
                kitchen_state: fresh.kitchen_state,
                bar_state: fresh.bar_state,
                is_ready: isLineReady(fresh),
              }
            : null,
        },
        { status: 409 },
      )
    }

    /**
     * The audit row. A failure here does NOT fail the request: the state change has already
     * landed and is correct, and answering non-2xx would make a screen re-bump a line that is
     * already done. Logged loudly instead -- same trade as the creation events.
     */
    const { error: eventError } = await supabase.from('order_line_events').insert({
      restaurant_id: terminal.restaurantId,
      order_line_id: lineId,
      station,
      from_state: currentState,
      to_state: toState,
      actor_kind: 'station',
      // ADR-005 §8.1: a station screen has no signed-in human today. NULL is honest; an
      // unattributed event is still evidence the transition happened.
      actor_user_id: null,
    })

    if (eventError) {
      console.error(
        '[station/order-lines/state] the state moved but its audit event was NOT recorded',
        { lineId, station, from: currentState, to: toState, error: eventError },
      )
    }

    return NextResponse.json({
      ok: true,
      unchanged: false,
      line: {
        id: updated.id,
        route_to: updated.route_to,
        kitchen_state: updated.kitchen_state,
        bar_state: updated.bar_state,
        is_ready: isLineReady(updated),
      },
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[station/order-lines/state POST]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
