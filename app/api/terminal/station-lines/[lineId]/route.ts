import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { ORDER_LINES_TABLE, ORDER_LINE_EVENTS_TABLE } from '@/lib/stations/schema-assumptions'
import { assertTerminalPairedToStation, StationPairingMismatchError } from '@/lib/stations/station-pairing'

export const dynamic = 'force-dynamic'

const KITCHEN_STATE_BY_ACTION = {
  cooked: 'cooked',
  ready_to_run: 'ready_to_run',
} as const

type Action = keyof typeof KITCHEN_STATE_BY_ACTION

/**
 * feat/station-screens-v1 — the kitchen screen's two taps. Station marks a line Cooked; the
 * pass marks it Ready to run.
 *
 * Writes BOTH halves of schema-assumptions.ts's ruling (4): sets order_lines.kitchen_state (the
 * column a screen reads — never bar_state, which is a separate column entirely, so this can
 * never clear the bar's half of a 'both' line) and appends an order_line_events row as the
 * audit trail. The two writes are NOT atomic here — that would need a single RPC on the other
 * session's side, which this branch does not own (ruled: do not write those migrations). If the
 * second write fails, the line's state has still moved and is correct; only the audit trail is
 * short one row, logged so it is not silently lost.
 *
 * TODO(schema-relay): table/column names are the ASSUMED shape in
 * lib/stations/schema-assumptions.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ lineId: string }> }) {
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

    const { lineId } = await params
    const body = (await req.json().catch(() => ({}))) as { action?: string }

    if (!body.action || !(body.action in KITCHEN_STATE_BY_ACTION)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    const action = body.action as Action
    const nowIso = new Date().toISOString()

    const { error: updateError } = await supabase
      .from(ORDER_LINES_TABLE)
      .update({ kitchen_state: KITCHEN_STATE_BY_ACTION[action] })
      .eq('id', lineId)
      .eq('restaurant_id', terminal.restaurantId)

    if (updateError) throw updateError

    const { error: eventError } = await supabase.from(ORDER_LINE_EVENTS_TABLE).insert({
      restaurant_id: terminal.restaurantId,
      order_line_id: lineId,
      station: 'kitchen',
      event_type: action,
      created_at: nowIso,
      created_by: terminal.terminalId,
    })

    if (eventError) {
      console.error('[station-lines/:lineId] state updated but the event log write failed:', eventError)
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[station-lines/:lineId] failed:', err)
    return NextResponse.json({ error: 'Failed to record the line event' }, { status: 500 })
  }
}
