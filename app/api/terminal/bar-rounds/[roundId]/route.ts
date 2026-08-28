import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { ORDER_LINES_TABLE, ORDER_LINE_EVENTS_TABLE } from '@/lib/stations/schema-assumptions'

export const dynamic = 'force-dynamic'

/**
 * feat/station-screens-v1 — the bar screen's one tap: moves a whole round from IN to OUT.
 *
 * A "round" is not its own table (schema-assumptions.ts) — `roundId` IS an order_id. Sets
 * bar_state = 'out' on every bar-routed order_lines row under it (never kitchen_state — a
 * separate column, so this can never clear a 'both' line's kitchen half) and appends one
 * order_line_event per line as the audit trail, same non-atomicity note as
 * app/api/terminal/station-lines/[lineId]/route.ts.
 *
 * TODO(schema-relay): table/column names are the ASSUMED shape in
 * lib/stations/schema-assumptions.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ roundId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json({ error: 'Station screens are not enabled for this restaurant' }, { status: 403 })
    }

    const { roundId: orderId } = await params
    const nowIso = new Date().toISOString()

    const { data: lines, error: linesError } = await supabase
      .from(ORDER_LINES_TABLE)
      .select('id')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('order_id', orderId)
      .in('route_to', ['bar', 'both'])

    if (linesError) throw linesError

    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: 'No bar-routed lines found for this round' }, { status: 404 })
    }

    const lineIds = lines.map((line) => line.id)

    const { error: updateError } = await supabase
      .from(ORDER_LINES_TABLE)
      .update({ bar_state: 'out' })
      .in('id', lineIds)

    if (updateError) throw updateError

    const { error: eventError } = await supabase.from(ORDER_LINE_EVENTS_TABLE).insert(
      lineIds.map((lineId) => ({
        restaurant_id: terminal.restaurantId,
        order_line_id: lineId,
        station: 'bar' as const,
        event_type: 'out' as const,
        created_at: nowIso,
        created_by: terminal.terminalId,
      })),
    )

    if (eventError) {
      console.error('[bar-rounds/:roundId] state updated but the event log write failed:', eventError)
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[bar-rounds/:roundId] failed:', err)
    return NextResponse.json({ error: 'Failed to bump the round out' }, { status: 500 })
  }
}
