import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import {
  assertTerminalPairedToStation,
  isStationKind,
  StationPairingMismatchError,
} from '@/lib/stations/station-pairing'
import { GET as getStationLines } from '@/app/api/station/lines/route'

export const dynamic = 'force-dynamic'

/**
 * feat/station-screens-v1 — the initial (and only) snapshot the kitchen and bar screens fetch.
 *
 * ============================================================================================
 * FIXED 2026-08-28 — RETIRED THE SECOND, GUESSED READ LAYER
 * ============================================================================================
 *
 * This used to query order_lines/order_line_events directly against a GUESSED shape
 * (lib/stations/schema-assumptions.ts, now deleted) and hand the raw rows to the frontend for
 * lib/stations/map-raw-lines.ts to reassemble into cards. That is a second, independently
 * evolving copy of exactly what GET /api/station/lines (ADR-005 §5, lib/orders/order-lines.ts)
 * already computes correctly — the NOT-FINISHED filter, the per-order grouping, is_ready via the
 * one shared isLineReady() — and it is precisely the kind of duplication that let 'cooked'
 * silently fall out of a hand-rolled `.eq(column, 'outstanding')` filter the real route's own
 * docblock warns about.
 *
 * So this route now does ONLY what is specific to it — the feature flag and the screen-pairing
 * gate (20260828230000_terminal_station_pairing.sql), preserved in exactly the same order as
 * before: requireFeature, then assertTerminalPairedToStation, BEFORE any board data is touched —
 * and then hands the same incoming request straight to the real GET /api/station/lines handler,
 * in-process. Both routes agree on the same `?station=kitchen|bar` query convention already
 * present on this request's own URL, so nothing needs reconstructing beyond the terminal's own
 * Authorization header, which `req` already carries and the real route re-validates itself.
 *
 * The response the screens now receive is the REAL contract's own shape (`{ station, orders,
 * server_time }`, each order card carrying `lines` with `kitchen_state`/`bar_state`/`is_ready`)
 * — see lib/stations/map-raw-lines.ts, rewritten to map THAT shape instead of a raw table dump.
 */
export async function GET(req: Request) {
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

    const station = String(new URL(req.url).searchParams.get('station') ?? '').trim().toLowerCase()
    if (!isStationKind(station)) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }

    try {
      await assertTerminalPairedToStation(supabase, terminal, station)
    } catch (err) {
      if (err instanceof StationPairingMismatchError) {
        return NextResponse.json({ error: err.message, code: err.code, pairedTo: err.pairedTo }, { status: 403 })
      }
      throw err
    }

    return getStationLines(req)
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/station-lines] failed:', err)
    return NextResponse.json({ error: 'Failed to load station lines' }, { status: 500 })
  }
}
