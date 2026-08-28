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

export async function GET(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

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
    const summary = { total_lines: 0, outstanding: 0, ready: 0, voided: 0 }

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

      const voided = isVoided(line)
      const ready = !voided && isLineReady(line)

      summary.total_lines += 1
      if (voided) summary.voided += 1
      else if (ready) summary.ready += 1
      else summary.outstanding += 1

      ;(grouped.get(orderId)!.lines as Array<Record<string, unknown>>).push({
        id: line.id,
        name_snapshot: line.name_snapshot,
        quantity: line.quantity,
        line_note: line.line_note,
        route_to: line.route_to,
        kitchen_state: line.kitchen_state,
        bar_state: line.bar_state,
        // Computed server-side, one definition, so the waiter's view and the station screens
        // cannot disagree about the same plate.
        is_ready: ready,
        is_voided: voided,
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
       * TRUE when the tab has lines and every one of them is ready or voided. This is the
       * "nothing outstanding at this table" signal; it is NOT a payment state and says nothing
       * about whether the bill has been settled.
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
