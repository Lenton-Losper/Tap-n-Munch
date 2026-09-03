import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { featureDenialBody } from '@/lib/stations/faults'
import {
  assertTerminalPairedToStation,
  isStationKind,
  StationPairingMismatchError,
} from '@/lib/stations/station-pairing'
import { stationLinesForValidatedTerminal } from '@/app/api/station/lines/route'

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

    /**
     * THREE INDEPENDENT CHECKS, ONE ROUND TRIP INSTEAD OF THREE.
     *
     * Measured on production 2026-09-03: this route's median was 2119 ms while the queries behind
     * it execute in ~1 ms. The cost was never the database — it was ~205 ms of Windhoek-to-Supabase
     * round trip, paid once per await, in a strict chain. validateTerminalRecord, requireFeature
     * and assertTerminalPairedToStation share no data and no ordering requirement, so they were
     * three waits for one wait's worth of work.
     *
     * ORDER OF REFUSAL IS PRESERVED EXACTLY, which is why this is allSettled and not all. Running
     * concurrently is not the same as reporting concurrently: `Promise.all` surfaces whichever
     * rejects FIRST, so a pairing mismatch could start being reported where a disabled venue used
     * to be, silently changing which of #370's messages a screen shows. The results are therefore
     * evaluated below in the same sequence the awaits used to run in.
     *
     * The station parameter is parsed first because it needs no I/O, but its 400 is still returned
     * in its original position — after the feature check — so an unknown station on a disabled
     * venue keeps answering STATION_SCREENS_DISABLED exactly as before.
     */
    const station = String(new URL(req.url).searchParams.get('station') ?? '').trim().toLowerCase()
    const stationValid = isStationKind(station)

    const [validation, feature, pairing] = await Promise.allSettled([
      validateTerminalRecord(supabase, terminal),
      requireFeature(terminal.restaurantId, 'station_screens_enabled'),
      // Only worth asking when the station is a real one; an invalid station has no pairing to check.
      stationValid ? assertTerminalPairedToStation(supabase, terminal, station) : Promise.resolve(null),
    ])

    // 1. Terminal record — threw a Response before, still does.
    if (validation.status === 'rejected') throw validation.reason

    /**
     * 2. Feature flag. A REJECTION HERE IS TREATED AS 'unreadable', not as allowed: requireFeature
     * already catches its own errors, but if it ever threw, failing open would hand a screen the
     * board for a venue whose settings we could not read.
     */
    const featureCheck =
      feature.status === 'fulfilled' ? feature.value : { allowed: false, reason: 'unreadable' as const }
    if (!featureCheck.allowed) {
      return NextResponse.json(featureDenialBody(featureCheck.reason), { status: 403 })
    }

    // 3. Station parameter.
    if (!stationValid) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }

    // 4. Pairing.
    if (pairing.status === 'rejected') {
      const err = pairing.reason
      if (err instanceof StationPairingMismatchError) {
        return NextResponse.json({ error: err.message, code: err.code, pairedTo: err.pairedTo }, { status: 403 })
      }
      throw err
    }

    /**
     * HANDS OVER WHAT IT ALREADY ESTABLISHED, rather than delegating to the route handler.
     *
     * This used to call `GET` from the same module, which re-ran validateTerminalRecord and
     * requireFeature -- the two queries just performed above, in a second sequential round trip.
     * Worker->Supabase is roughly 520 ms, so that duplication was about a third of this endpoint's
     * entire response time, spent re-deciding something already decided.
     *
     * The same `supabase` client is passed too, so the handover reuses this request's connection
     * rather than constructing a second one.
     */
    return stationLinesForValidatedTerminal(req, terminal, supabase)
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/station-lines] failed:', err)
    return NextResponse.json({ error: 'Failed to load station lines' }, { status: 500 })
  }
}
