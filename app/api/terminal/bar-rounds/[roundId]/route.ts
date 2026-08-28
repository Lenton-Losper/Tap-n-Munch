import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { assertTerminalPairedToStation, StationPairingMismatchError } from '@/lib/stations/station-pairing'
import { POST as bumpOrderLineState } from '@/app/api/station/order-lines/[lineId]/state/route'

export const dynamic = 'force-dynamic'

/**
 * feat/station-screens-v1 — the bar screen's one tap: moves a whole round straight from IN to
 * OUT. A "round" is not its own table — `roundId` IS an order_id, same as before.
 *
 * ============================================================================================
 * FIXED 2026-08-28 — SAME DEFECT CLASS AS THE KITCHEN BUMP, PLUS ITS OWN
 * ============================================================================================
 *
 * This used to write `bar_state: 'out'` directly (lib/stations/schema-assumptions.ts, now
 * retired). 'out' is not, and never was, a value in the real vocabulary
 * (lib/orders/order-lines.ts's LineState is 'outstanding' | 'cooked' | 'ready' | 'voided') — the
 * same root defect as the kitchen route's 'ready_to_run', a value invented for the guessed
 * schema that the real order_lines_bar_state_check CHECK constraint has never accepted, plus the
 * same event_type/created_at/created_by column-name mismatch on the audit insert.
 *
 * Per the brief: the bar screen's one tap maps to `to_state: 'ready'` directly — there is no
 * 'cooked' step for the bar. Confirmed against lib/orders/order-lines.ts rather than assumed:
 * nothing in that module or in POST /api/station/order-lines/[lineId]/state enforces a sequential
 * outstanding -> cooked -> ready path; a station may write 'cooked', 'ready' or 'outstanding'
 * from whatever the line's current state is. A round going straight from outstanding to ready in
 * one tap is a legal transition under that contract, not a shortcut around it.
 *
 * There is no round-level bump in the real domain — POST /api/station/order-lines/[lineId]/state
 * moves ONE line. A "round" here is every line the BAR still owns (bar_state IS NOT NULL — the
 * same test stationsOwnedBy() uses, not a route_to enumeration that would silently miss
 * 'unrouted' lines the way the old query did) under this order, so the one tap fans out into one
 * delegate call per line, each doing its own conditional update and its own atomic audit-event
 * write. Already-ready lines come back `unchanged: true` (not an error, see the delegate's own
 * double-tap handling); a genuinely voided line is correctly refused per-line and surfaced below
 * rather than silently skipped.
 */
export async function POST(req: Request, { params }: { params: Promise<{ roundId: string }> }) {
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
      await assertTerminalPairedToStation(supabase, terminal, 'bar')
    } catch (err) {
      if (err instanceof StationPairingMismatchError) {
        return NextResponse.json({ error: err.message, code: err.code, pairedTo: err.pairedTo }, { status: 403 })
      }
      throw err
    }

    const { roundId: orderId } = await params

    const { data: lines, error: linesError } = await supabase
      .from('order_lines')
      .select('id')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('order_id', orderId)
      .not('bar_state', 'is', null)

    if (linesError) throw linesError

    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: 'No bar-routed lines found for this round' }, { status: 404 })
    }

    const results = await Promise.all(
      (lines as Array<{ id: string }>).map(async (line) => {
        const delegateReq = new Request(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify({ station: 'bar', to_state: 'ready' }),
        })
        const res = await bumpOrderLineState(delegateReq, { params: Promise.resolve({ lineId: line.id }) })
        const body = await res.json().catch(() => null)
        return { lineId: line.id, ok: res.ok, status: res.status, body }
      }),
    )

    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      console.error('[bar-rounds/:roundId] one or more lines in this round failed to reach ready', {
        orderId,
        failed,
      })
      return NextResponse.json(
        {
          error: 'One or more lines in this round could not be marked ready.',
          code: 'ROUND_PARTIALLY_FAILED',
          lines: results,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({ ok: true, lines: results.map((r) => r.body?.line ?? null) })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[bar-rounds/:roundId] failed:', err)
    return NextResponse.json({ error: 'Failed to bump the round out' }, { status: 500 })
  }
}
