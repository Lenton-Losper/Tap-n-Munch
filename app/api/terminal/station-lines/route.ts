import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { ORDER_LINES_TABLE, ORDER_LINE_EVENTS_TABLE } from '@/lib/stations/schema-assumptions'

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
 */
export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json({ error: 'Station screens are not enabled for this restaurant' }, { status: 403 })
    }

    const { data: openOrders, error: ordersError } = await supabase
      .from('orders')
      .select('id, table_number')
      .eq('restaurant_id', terminal.restaurantId)
      .not('status', 'in', '(completed,cancelled)')

    if (ordersError) throw ordersError

    const openOrderIds = (openOrders ?? []).map((o) => o.id)
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
