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
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { featureDenialBody, STATION_FAULT_CODES } from '@/lib/stations/faults'
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

    /**
     * DEFENSE IN DEPTH. This is the real domain route `/api/terminal/station-lines` delegates to
     * in-process after its own feature-flag and pairing checks -- but it is also its own exported
     * route handler, reachable directly over HTTP with nothing but a valid terminal token. Found
     * 2026-08-28 while gating the waiter-flow routes on this same flag. No legitimate client calls
     * this URL directly (lib/stations/data-port.ts only ever calls the terminal wrapper), so this
     * closes a reachability gap rather than changing an actual call path.
     */
    const featureCheck = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!featureCheck.allowed) {
      return NextResponse.json(featureDenialBody(featureCheck.reason), { status: 403 })
    }

    /**
     * #370: this used to be a 403 with NO `code` at all, which the screen read as "not the pairing
     * error, therefore the venue flag must be off" and rendered as "ask your manager to enable
     * station screens". A screen paired without `orders:read` is not a venue-settings problem --
     * re-pairing fixes it, and no amount of looking at the venue's flag ever will. It is
     * identifiable on the wire now, like every other refusal this route can return.
     */
    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json(
        { error: 'This screen is not permitted to read orders', code: STATION_FAULT_CODES.MISSING_PERMISSION },
        { status: 403 },
      )
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
      /**
       * NOT-COLLECTED, rather than a list of active states.
       *
       * This used to be `.eq(stateColumn, 'outstanding')`. Adding 'cooked' would have made that
       * filter silently drop every plated dish off the board -- no error, no slow query, just a
       * plate that is not there. Exactly the failure the old partial index had.
       *
       * 20260829160000: this used to exclude 'ready' too, because no pinned Ready zone existed to
       * show it in and the board would have had nowhere to put it. Now that zone exists, so
       * 'ready' lines stay ON the board -- only 'collected' (picked up) and 'voided' (cancelled at
       * the terminal) leave it.
       *
       * Enumerating the TERMINAL states instead means the next value added to the vocabulary
       * shows up on the board by default, which is the safe direction to fail: a state nobody
       * has taught the screen about appears and gets questioned, rather than vanishing.
       */
      .not(stateColumn, 'is', null)
      .not(stateColumn, 'in', '("collected","voided")')
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
      .select('id, order_number, table_number, placed_at, order_instructions, tab_id')
      .in('id', orderIds)

    if (ordersError) throw ordersError

    /**
     * WHO SENT THIS ORDER — the name a cook can call back across the pass.
     *
     * Two batched hops: orders.tab_id -> tabs.opened_by_user_id -> users.name. A tab opened by a
     * customer scanning a QR code has no opened_by_user_id at all (see
     * app/api/terminal/tables/[tableId]/open/route.ts), so this is legitimately absent for a large
     * share of orders and every card must render without it.
     *
     * DEGRADES TO ABSENT, NEVER THROWS — same trade the cooked_at/ready_at reads below already
     * make. A missing name is a slightly less useful card; throwing here would be a blank pass in
     * the middle of service.
     *
     * ONLY THE DISPLAY NAME CROSSES THE WIRE. No email, no user id, no role. A wall screen in a
     * kitchen is visible to everyone in the room, and often through the pass to customers.
     */
    const servedByOrderId = new Map<string, string>()
    const orderRows = (orders ?? []) as Array<Record<string, unknown>>
    const tabIds = [
      ...new Set(
        orderRows
          .map((o) => o.tab_id)
          .filter((t): t is string => typeof t === 'string' && t.length > 0),
      ),
    ]
    if (tabIds.length > 0) {
      const { data: tabs, error: tabsError } = await supabase
        .from('tabs')
        .select('id, opened_by_user_id')
        .in('id', tabIds)

      if (tabsError) {
        console.error('[station/lines] served_by unavailable', tabsError.message)
      } else {
        const openerByTabId = new Map<string, string>()
        for (const tab of (tabs ?? []) as Array<Record<string, unknown>>) {
          const opener = tab.opened_by_user_id
          if (typeof opener === 'string' && opener.length > 0) openerByTabId.set(String(tab.id), opener)
        }
        const userIds = [...new Set([...openerByTabId.values()])]
        if (userIds.length > 0) {
          const { data: users, error: usersError } = await supabase
            .from('users')
            .select('id, name')
            .in('id', userIds)

          if (usersError) {
            console.error('[station/lines] served_by names unavailable', usersError.message)
          } else {
            const nameByUserId = new Map<string, string>()
            for (const user of (users ?? []) as Array<Record<string, unknown>>) {
              const name = typeof user.name === 'string' ? user.name.trim() : ''
              if (name) nameByUserId.set(String(user.id), name)
            }
            for (const order of orderRows) {
              const tabId = typeof order.tab_id === 'string' ? order.tab_id : null
              const opener = tabId ? openerByTabId.get(tabId) : undefined
              const name = opener ? nameByUserId.get(opener) : undefined
              if (name) servedByOrderId.set(String(order.id), name)
            }
          }
        }
      }
    }

    const orderById = new Map<string, Record<string, unknown>>()
    for (const order of (orders ?? []) as Array<Record<string, unknown>>) {
      orderById.set(String(order.id), order)
    }

    /**
     * WHEN EACH LINE WAS ACTUALLY COOKED, not when its order was placed.
     *
     * The board escalated a cooked card on the ORDER age because this payload never carried a
     * per-line transition time. That is wrong in ordinary service, not only in old fixtures: a
     * steak that legitimately took eleven minutes to cook goes red the instant it is tapped
     * Cooked, because its ORDER is eleven minutes old. Every cooked card then turns red within six
     * minutes of the round landing, the pass sees a wall of identical red, and the colour carries
     * no information — which is what the owner saw on the wall on 2026-08-28.
     *
     * The timestamp existed the whole time and only the contract was missing it:
     * `order_line_events` records every transition with `occurred_at`.
     *
     * Read newest-first, keep the FIRST seen per line. A line can be cooked, sent back to
     * outstanding and cooked again, and the clock a cook cares about starts at the LATEST cooking.
     *
     * A failure here must not blank the board, so it degrades to order age rather than throwing.
     */
    const cookedAtByLineId = new Map<string, string>()
    const { data: cookedEvents, error: cookedEventsError } = await supabase
      .from('order_line_events')
      .select('order_line_id, occurred_at')
      .in('order_line_id', lineRows.map((l) => String(l.id)))
      .eq('station', station)
      .eq('to_state', 'cooked')
      .order('occurred_at', { ascending: false })

    if (cookedEventsError) {
      console.error('[station/lines] cooked_at unavailable', cookedEventsError.message)
    } else {
      for (const event of (cookedEvents ?? []) as Array<Record<string, unknown>>) {
        const lineId = String(event.order_line_id)
        if (!cookedAtByLineId.has(lineId)) {
          cookedAtByLineId.set(lineId, String(event.occurred_at))
        }
      }
    }

    /**
     * WHEN EACH LINE ACTUALLY REACHED THE PASS, not when it was cooked or placed.
     *
     * 20260829160000: the Ready zone is pinned and ages on its own clock -- "sitting uncollected"
     * is a different problem from "not yet made", and the board rebuild rules that only THIS zone
     * escalates by age (the TO MAKE zone stays neutral for bar, always). Same newest-first,
     * keep-first-seen shape as cooked_at, same degrade-to-null-not-throw on failure.
     */
    const readyAtByLineId = new Map<string, string>()
    const { data: readyEvents, error: readyEventsError } = await supabase
      .from('order_line_events')
      .select('order_line_id, occurred_at')
      .in('order_line_id', lineRows.map((l) => String(l.id)))
      .eq('station', station)
      .eq('to_state', 'ready')
      .order('occurred_at', { ascending: false })

    if (readyEventsError) {
      console.error('[station/lines] ready_at unavailable', readyEventsError.message)
    } else {
      for (const event of (readyEvents ?? []) as Array<Record<string, unknown>>) {
        const lineId = String(event.order_line_id)
        if (!readyAtByLineId.has(lineId)) {
          readyAtByLineId.set(lineId, String(event.occurred_at))
        }
      }
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
        /**
         * ZERO IS NOT A TABLE. `?? null` does not catch it, so order #5 rendered as "Table 0" on
         * the wall — a table that does not exist in any restaurant. Two staging orders carry it,
         * and it is a default left by a writer that had no table to record rather than a real
         * number anyone can shout across a kitchen.
         *
         * Normalised to null HERE rather than in the component so every consumer of this payload
         * — board, runner view, any future screen — gets the same answer, and so a screen never
         * has to know that zero is a sentinel.
         */
        table_number:
          order?.table_number === 0 || order?.table_number == null
            ? null
            : order.table_number,
        /**
         * EAT-IN OR COUNTER — DERIVED, not stored. There is no order-type column in this schema
         * and adding one would be a migration for a fact the data already carries: an order with a
         * table is being eaten at that table, and an order without one is collected at the counter.
         * `restaurants.is_counter_service` says what a VENUE is; this says what this ORDER is, and
         * a table-service venue still takes the occasional counter order.
         *
         * Zero is normalised away above before this reads it, so a sentinel table cannot masquerade
         * as eat-in.
         */
        order_type:
          order?.table_number === 0 || order?.table_number == null ? 'counter' : 'eat_in',
        /** Absent for QR/customer-opened tabs. See servedByOrderId's docblock. */
        served_by: servedByOrderId.get(orderId) ?? null,
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
        // Null until this station taps Cooked. The board keys its escalation on this and falls
        // back to the order's age only when it is absent.
        cooked_at: cookedAtByLineId.get(String(line.id)) ?? null,
        // Null until this station's half reaches 'ready'. The pinned Ready zone keys ITS
        // escalation on this -- a different clock from cooked_at, started by a different actor.
        ready_at: readyAtByLineId.get(String(line.id)) ?? null,
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
