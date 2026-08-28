/**
 * ADR-005 §5 -- what the waiter's TABLE VIEW reads: everything ordered on this tab, and which of
 * it is still being made.
 *
 * ============================================================================================
 * WHY THIS ENDPOINT HAD TO EXIST
 * ============================================================================================
 *
 * The table view needs "outstanding vs ready, for THIS table". Nothing could answer that:
 *
 *   * POST /api/terminal/rounds is write-only.
 *   * GET /api/station/lines is scoped by restaurant AND state='outstanding', with no tab or
 *     table filter -- and done lines drop out of it entirely, so "not returned" is
 *     indistinguishable from "the call failed".
 *   * The legacy GET /api/terminal/tables carries tab.orders[].items[], which is the BILLING
 *     shape and has no line state in it at all.
 *
 * The available workaround was to join the tab's items against /api/station/lines for both
 * stations and treat "on the tab but not returned" as ready. That silently reports READY for
 * anything a failed station call omits -- a waiter carrying food that was never made, from a
 * screen that looked confident. Not shippable as a readiness signal.
 *
 * So the read exists here, scoped to one tab, returning every line WITH its per-station state.
 *
 * ============================================================================================
 * IT RETURNS DONE AND VOIDED LINES TOO, DELIBERATELY
 * ============================================================================================
 *
 * The station screens want only outstanding work. A waiter wants the opposite: the whole history
 * of the table, because "has the starter gone out yet" is answered by a line that is DONE. A
 * filtered view would make the table look emptier than the bill.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { isLineReady, type LineRouteTo, type LineState } from '@/lib/orders/order-lines'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

type LineRow = {
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
}

/** Voided if EVERY station that owns the line has voided it. A half-voided line is still work. */
function isVoided(line: { kitchen_state: LineState | null; bar_state: LineState | null }): boolean {
  const owned = [line.kitchen_state, line.bar_state].filter((s): s is LineState => s != null)
  return owned.length > 0 && owned.every((s) => s === 'voided')
}

/** Collected if EVERY station that owns the line has been collected from. A 'both' line with one
 *  half collected and one still sitting ready is NOT this -- there is still something on a pass
 *  waiting for a waiter, and the bucket below must say so. */
function isCollected(line: { kitchen_state: LineState | null; bar_state: LineState | null }): boolean {
  const owned = [line.kitchen_state, line.bar_state].filter((s): s is LineState => s != null)
  return owned.length > 0 && owned.every((s) => s === 'collected')
}

/**
 * ============================================================================================
 * THE SECOND collected GAP: THE FOOD-UP SIGNAL, NOT THE LABEL
 * ============================================================================================
 *
 * Found by the terminal handover, 20260829 -- Max could read the symptom (FOOD UP never clears)
 * but not this route to find the cause. Distinct from serializeStateForLegacyTerminal above:
 * that one is about a per-line STATUS LABEL and is genuinely harmless to get slightly stale.
 * This one is the AGGREGATE the floor badge counts, and getting it wrong is not cosmetic.
 *
 * `isLineReady()` (lib/orders/order-lines.ts) treats 'collected' as still ready, deliberately --
 * "one step past ready, not a step back" is the right answer to "has the pass finished with
 * this line". But the terminal's floor badge is not asking that question. It is asking "is there
 * food sitting at a pass RIGHT NOW that a waiter has not walked over for yet" -- and that
 * question's answer flips to false the moment a line is collected, not never.
 *
 * Before this fix, `is_ready`/`summary.ready` on this route reused isLineReady()'s general
 * answer, so a collected line stayed counted in the 'ready' bucket forever. The terminal source
 * has never heard the word 'collected' and only ever counts is_ready lines for FOOD UP, so it had
 * no way to notice the dish it was told about was already gone -- the badge could only ever turn
 * ON, never off, once the first line reached the pass.
 *
 * THE FIX IS SCOPED TO THIS ROUTE, NOT TO isLineReady(). The general "has this been handled"
 * question and the terminal's "is something waiting for me right now" question are different
 * questions that happened to have the same answer until 'collected' existed; giving them the
 * same name (`is_ready`) on two different responses is what let this gap open. This route now
 * computes its OWN four-way bucket from the raw states before any legacy-terminal translation,
 * and `is_ready` here means exactly "in the ready bucket" -- true for 'ready', false for
 * 'collected', matching what a floor badge actually needs.
 *
 * `all_ready` is UNCHANGED (still `outstanding === 0`) -- settling a table has never depended on
 * whether ready food was physically collected, only on whether anything is still being made.
 */
type LineBucket = 'outstanding' | 'ready' | 'collected' | 'voided'

function bucketForLine(line: { kitchen_state: LineState | null; bar_state: LineState | null }): LineBucket {
  if (isVoided(line)) return 'voided'
  if (isCollected(line)) return 'collected'
  if (isLineReady(line)) return 'ready'
  return 'outstanding'
}

/**
 * 'collected' (20260829160000, the board rebuild's pinned Ready zone) DOWNGRADES to 'ready' in
 * the raw kitchen_state/bar_state strings THIS route serialises. Nowhere else -- the station
 * screens (lib/stations/map-raw-lines.ts) read the real five-value vocabulary directly and must
 * keep doing so.
 *
 * ============================================================================================
 * WHY THIS EXISTS: THE ready_to_run SHAPE, IN THE READ DIRECTION
 * ============================================================================================
 *
 * `is_ready` on this same response is computed server-side (isLineReady already treats
 * 'collected' as ready) and is safe for any client regardless of its own vocabulary. The raw
 * kitchen_state/bar_state strings are not -- a waiter terminal on a build that predates
 * 'collected' (confirmed: at least app_version 2.13) may render a floor badge off THOSE strings
 * directly rather than off is_ready, the same way the old (guessed) 'ready_to_run' value broke a
 * client that read it literally. A fifth value such a client has never seen falls into whatever
 * its switch's default does -- worst case, a picked-up plate reads as not-started, which is the
 * most misleading direction a floor badge could fail in.
 *
 * Serialising 'collected' as 'ready' costs nothing true: to a waiter, "picked up" and "ready" both
 * mean nothing is left to do at that line. It is not a lie the way defaulting to 'outstanding'
 * would be.
 *
 * ============================================================================================
 * WHEN THIS CAN GO -- A SHIM NOBODY CAN DATE IS A SHIM NOBODY REMOVES
 * ============================================================================================
 *
 * Remove this once every terminal actually in the field has an app_version that knows
 * 'collected' -- i.e. once `select min(app_version) from <wherever app_version is tracked, see
 * app/api/terminal/heartbeat/route.ts>` for restaurants running the waiter-led flow is at or past
 * that release. Until a version handshake exists to answer that question from data rather than
 * from memory, treat "have we heard from anything older" as the honest way to check it, and leave
 * this in.
 */
function serializeStateForLegacyTerminal(state: LineState | null): LineState | null {
  return state === 'collected' ? 'ready' : state
}

export async function GET(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    /**
     * ADR-005 is a station_screens_enabled venue's flow, not server policy yet. Riviera-only was
     * an accident of client version -- Mingle and ChowNow are protected only by an old APK never
     * calling this endpoint, not by anything server-side. Added 2026-08-28.
     */
    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }

    // Scoped by restaurant as well as id, so a terminal cannot read another venue's tab by
    // guessing a uuid.
    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, table_number, status, total, opened_by_user_id, created_at')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (tabError) throw tabError
    if (!tab?.id) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    const { data: lines, error: linesError } = await supabase
      .from('order_lines')
      .select(
        'id, order_id, source_item_index, name_snapshot, quantity, line_note, route_to, kitchen_state, bar_state, created_at',
      )
      .eq('restaurant_id', terminal.restaurantId)
      .eq('tab_id', tabId)
      .order('created_at', { ascending: true })

    if (linesError) throw linesError

    const lineRows = (lines ?? []) as LineRow[]

    const orderIds = [...new Set(lineRows.map((l) => String(l.order_id)))]
    const ordersById = new Map<string, Record<string, unknown>>()

    if (orderIds.length > 0) {
      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('id, order_number, placed_at, order_instructions, total')
        .in('id', orderIds)

      if (ordersError) throw ordersError
      for (const order of (orders ?? []) as Array<Record<string, unknown>>) {
        ordersById.set(String(order.id), order)
      }
    }

    // One clock for the whole payload.
    const now = Date.now()
    // 'collected' is its own bucket, additive -- a pre-collected terminal reads outstanding/
    // ready/voided by name, same as before, and now correctly sees 'ready' drop once a line is
    // actually picked up rather than counting it forever. See bucketForLine's own docblock.
    const summary = { total_lines: 0, outstanding: 0, ready: 0, collected: 0, voided: 0 }

    const grouped = new Map<string, Record<string, unknown>>()

    for (const line of lineRows) {
      const orderId = String(line.order_id)

      if (!grouped.has(orderId)) {
        const order = ordersById.get(orderId)
        const placedAt = order?.placed_at ? String(order.placed_at) : null
        const placedMs = placedAt ? new Date(placedAt).getTime() : Number.NaN
        grouped.set(orderId, {
          order_id: orderId,
          order_number: order?.order_number ?? null,
          order_instructions: order?.order_instructions ?? null,
          order_total: order?.total ?? null,
          placed_at: placedAt,
          seconds_since_placed: Number.isFinite(placedMs)
            ? Math.max(0, Math.round((now - placedMs) / 1000))
            : null,
          lines: [] as Array<Record<string, unknown>>,
        })
      }

      const bucket = bucketForLine(line)

      summary.total_lines += 1
      summary[bucket] += 1

      ;(grouped.get(orderId)!.lines as Array<Record<string, unknown>>).push({
        id: line.id,
        name_snapshot: line.name_snapshot,
        quantity: line.quantity,
        line_note: line.line_note,
        route_to: line.route_to,
        kitchen_state: serializeStateForLegacyTerminal(line.kitchen_state),
        bar_state: serializeStateForLegacyTerminal(line.bar_state),
        // is_ready means "in the ready bucket" -- see bucketForLine's docblock on why this is
        // NOT the same question as the general isLineReady(). is_collected is additive, for a
        // terminal that has been taught the word.
        is_ready: bucket === 'ready',
        is_collected: bucket === 'collected',
        is_voided: bucket === 'voided',
        unrouted: line.route_to === 'unrouted',
      })
    }

    return NextResponse.json({
      tab: {
        id: tab.id,
        table_number: tab.table_number ?? null,
        status: tab.status,
        total: tab.total,
        opened_at: tab.created_at,
        opened_by_user_id: tab.opened_by_user_id ?? null,
      },
      // Newest round last: a waiter reads a table top to bottom in the order it was ordered.
      orders: [...grouped.values()],
      /**
       * The counts the table view puts at the top. `total_lines` is FULFILMENT lines, which for
       * an item routed to both stations is still ONE line -- it is not a count of anything
       * billable, and must never be shown as a quantity of items sold.
       */
      summary,
      /**
       * TRUE when the tab has lines and every one of them is ready, collected, or voided. This is
       * the "nothing outstanding at this table" signal; it is NOT a payment state and says
       * nothing about whether the bill has been settled. UNCHANGED by the collected split above
       * -- settling has never depended on whether ready food was physically picked up, only on
       * whether anything is still being made.
       */
      all_ready: summary.total_lines > 0 && summary.outstanding === 0,
      /**
       * Lines only exist for rounds sent through the waiter flow. A tab that predates it, or a
       * QR tab, has a bill but no lines -- so the table view must render the bill from the tab
       * total and simply not claim anything about readiness.
       */
      has_lines: summary.total_lines > 0,
      server_time: new Date(now).toISOString(),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tabs/lines GET]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
