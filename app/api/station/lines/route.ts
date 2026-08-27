/**
 * ADR-005 §5 -- what a kitchen or bar screen reads.
 *
 * ============================================================================================
 * WHY AN ENDPOINT AND NOT A DIRECT SUPABASE READ
 * ============================================================================================
 *
 * The RLS policy on order_lines is `user_has_permission(restaurant_id, 'orders:read')`, and that
 * function resolves through restaurant_users keyed on `auth.uid()`.
 *
 * A wall-mounted monitor in a kitchen is not a signed-in Supabase user. `auth.uid()` is null, so
 * a direct SELECT returns ZERO ROWS -- silently, with no error, forever. A screen built that way
 * shows an empty pass all night and gives nobody a reason why.
 *
 * So the screens read through here, on the service role, with the terminal token deciding which
 * restaurant they may see.
 *
 * ============================================================================================
 * AUTH IS THE TERMINAL TOKEN, AND THAT IS NOT THE FINAL ANSWER
 * ============================================================================================
 *
 * ADR-005 §8.1 is unruled: terminal auth is a 1h JWT and event N requires a week of unattended
 * uptime. This route uses the only credential that exists today.
 *
 * When §8.1 is ruled it changes HOW A SCREEN OBTAINS a credential. It does not change this
 * route's shape or its response, so the station screens can be built against this contract now.
 *
 * ============================================================================================
 * 'unrouted' APPEARS ON BOTH SCREENS, DELIBERATELY
 * ============================================================================================
 *
 * A line whose category route_to was null, missing or unrecognised is owned by both stations. It
 * is returned to whichever screen asks, flagged, so a human sees it and asks why. Filtering it
 * out would be food that never gets made, which is the whole failure the 'unrouted' value exists
 * to prevent.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { isLineReady, type LineRouteTo, type LineState, type Station } from '@/lib/orders/order-lines'

export const dynamic = 'force-dynamic'

function isStation(value: string): value is Station {
  return value === 'kitchen' || value === 'bar'
}

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const station = String(new URL(req.url).searchParams.get('station') ?? '').trim().toLowerCase()
    if (!isStation(station)) {
      return NextResponse.json(
        { error: "station must be 'kitchen' or 'bar'", code: 'INVALID_STATION' },
        { status: 400 },
      )
    }

    const stateColumn = station === 'kitchen' ? 'kitchen_state' : 'bar_state'

    // Outstanding lines this station owns. An 'unrouted' line has BOTH state columns populated,
    // so it satisfies this filter on either screen without a special case.
    const { data: lines, error: linesError } = await supabase
      .from('order_lines')
      .select(
        'id, order_id, source_item_index, name_snapshot, quantity, line_note, route_to, kitchen_state, bar_state, created_at',
      )
      .eq('restaurant_id', terminal.restaurantId)
      .eq(stateColumn, 'outstanding')
      .order('created_at', { ascending: true })

    if (linesError) throw linesError

    const lineRows = (lines ?? []) as Array<{
      id: string
      order_id: string
      source_item_index: number
      name_snapshot: string
      quantity: number
      line_note: string | null
      route_to: LineRouteTo
      kitchen_state: LineState | null
      bar_state: LineState | null
      created_at: string
    }>

    if (lineRows.length === 0) {
      return NextResponse.json({
        station,
        orders: [],
        server_time: new Date().toISOString(),
      })
    }

    // Order headers, read separately rather than embedded: the screen needs the order number and
    // the table a human can shout, and a failed embed would silently drop the whole card.
    const orderIds = [...new Set(lineRows.map((l) => String(l.order_id)))]
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, order_number, table_number, placed_at, order_instructions')
      .in('id', orderIds)

    if (ordersError) throw ordersError

    const orderById = new Map<string, Record<string, unknown>>()
    for (const order of (orders ?? []) as Array<Record<string, unknown>>) {
      orderById.set(String(order.id), order)
    }

    // One clock for the whole payload, so two cards cannot report ages that disagree.
    const now = Date.now()

    const grouped = new Map<string, ReturnType<typeof emptyCard>>()

    function emptyCard(orderId: string) {
      const order = orderById.get(orderId)
      const placedAt = order?.placed_at ? String(order.placed_at) : null
      const placedAtMs = placedAt ? new Date(placedAt).getTime() : Number.NaN
      return {
        order_id: orderId,
        order_number: order?.order_number ?? null,
        table_number: order?.table_number ?? null,
        order_instructions: order?.order_instructions ?? null,
        placed_at: placedAt,
        // Server-computed: a screen that has been on a wall for a week does not have a clock
        // worth trusting.
        seconds_waiting: Number.isFinite(placedAtMs)
          ? Math.max(0, Math.round((now - placedAtMs) / 1000))
          : null,
        lines: [] as Array<Record<string, unknown>>,
      }
    }

    for (const line of lineRows) {
      const orderId = String(line.order_id)
      if (!grouped.has(orderId)) grouped.set(orderId, emptyCard(orderId))

      grouped.get(orderId)!.lines.push({
        id: line.id,
        name_snapshot: line.name_snapshot,
        quantity: line.quantity,
        line_note: line.line_note,
        route_to: line.route_to,
        kitchen_state: line.kitchen_state,
        bar_state: line.bar_state,
        // Computed here so the runner's view and the screens cannot disagree about a plate.
        is_ready: isLineReady(line),
        // Render these under a visible heading. Do not filter them out.
        unrouted: line.route_to === 'unrouted',
        // True when the OTHER station also owns this line, so the screen can say "bar has this
        // too" rather than leaving staff wondering why a drink is on the kitchen pass.
        shared_with_other_station: line.route_to === 'both' || line.route_to === 'unrouted',
      })
    }

    // Oldest order first: the pass is a queue, and the thing that has been waiting longest is the
    // thing a kitchen needs to see at the top.
    const cards = [...grouped.values()].sort((a, b) =>
      String(a.placed_at ?? '').localeCompare(String(b.placed_at ?? '')),
    )

    return NextResponse.json({
      station,
      orders: cards,
      server_time: new Date(now).toISOString(),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[station/lines GET]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
