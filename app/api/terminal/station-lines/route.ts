import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { ORDER_LINES_TABLE, ORDER_LINE_EVENTS_TABLE } from '@/lib/stations/schema-assumptions'
import {
  assertTerminalPairedToStation,
  isStationKind,
  StationPairingMismatchError,
} from '@/lib/stations/station-pairing'

export const dynamic = 'force-dynamic'

/**
 * feat/station-screens-v1 — the initial snapshot both the kitchen and bar screen fetch. One feed
 * for both screens: each maps it differently (lib/stations/map-raw-lines.ts) rather than the
 * server pre-filtering by station, so a route_to = 'both' line is visible to build both
 * screens' independent state.
 *
 * table_number is returned alongside the lines as a separate `orders` lookup — it is not a
 * column on order_lines (confirmed 2026-08-28 from live rows; see
 * lib/stations/schema-assumptions.ts). "Still on the board" is bounded by the order's own
 * status, excluding completed/cancelled.
 *
 * `?station=kitchen|bar` is REQUIRED (20260828230000_terminal_station_pairing.sql). Pairing is
 * pointless if the same code works against both URLs, so this is what makes "pair a screen"
 * (components/settings/station-screens-pairing-section.tsx) mean something.
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

    // #323-shaped: `orders` is unbounded past 1000 rows without an explicit range, and
    // `.eq('restaurant_id', ...)` alone does not narrow enough for the CI gate to accept it (a
    // busy venue's lifetime order count is not itself a small set) even though a REALLY open
    // board never is. fetchAllRows is the sanctioned way to say "all of them, paged."
    const openOrders = await fetchAllRows<{ id: string; table_number: string | number | null }>(
      supabase
        .from('orders')
        .select('id, table_number')
        .eq('restaurant_id', terminal.restaurantId)
        .not('status', 'in', '(completed,cancelled)'),
      { label: 'station-lines open orders' },
    )

    const openOrderIds = openOrders.map((o) => o.id)
    if (openOrderIds.length === 0) {
      return NextResponse.json({ lines: [], events: [], tableNumberByOrderId: {} })
    }

    const tableNumberByOrderId: Record<string, string> = {}
    for (const order of openOrders ?? []) {
      tableNumberByOrderId[order.id] = String(order.table_number ?? '—')
    }

    const { data: lines, error: linesError } = await supabase
      .from(ORDER_LINES_TABLE)
      .select('*')
      .eq('restaurant_id', terminal.restaurantId)
      .in('order_id', openOrderIds)

    if (linesError) throw linesError

    const lineIds = (lines ?? []).map((line) => line.id)
    if (lineIds.length === 0) {
      return NextResponse.json({ lines: [], events: [], tableNumberByOrderId })
    }

    const { data: events, error: eventsError } = await supabase
      .from(ORDER_LINE_EVENTS_TABLE)
      .select('*')
      .eq('restaurant_id', terminal.restaurantId)
      .in('order_line_id', lineIds)

    if (eventsError) throw eventsError

    return NextResponse.json({ lines: lines ?? [], events: events ?? [], tableNumberByOrderId })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[station-lines] failed:', err)
    return NextResponse.json({ error: 'Failed to load station lines' }, { status: 500 })
  }
}
