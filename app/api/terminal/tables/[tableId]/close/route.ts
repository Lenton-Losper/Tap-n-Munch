import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { closeTableSession } from '@/lib/session-manager'
import {
  blocksSettlement,
  fetchPendingOrderRequests,
  pendingOrderRequestValue,
  summarisePendingForTab,
} from '@/lib/tabs/pending-order-requests'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tableId } = await params

    /**
     * #120 — THE PREFLIGHT. This is the point of no return, so it is the one that must fail closed.
     *
     * `close_table_session` SETTLES every tab at the table and bumps `current_session_version`,
     * which evicts every customer session. A round still waiting for staff review is not in
     * `orders`, so nothing this route previously consulted could see it — and after the close it
     * re-inflates a tab that has been paid and closed the moment somebody presses Accept.
     *
     * REFUSING IS THE WHOLE FIX. This route does not accept, decline, or reassign anything; the
     * resolution is a human pressing Accept or Decline on the dashboard. What it stops is the
     * table being closed over the top of a decision nobody has made yet.
     *
     * The tabs read is scoped by restaurant AND table, and both filters are `.eq()` — parser-free.
     * `tableId` arrives from the URL path, and a caller-controlled value inside a PostgREST `.or()`
     * expression is this project's #242 / #254 defect class.
     */
    const { data: tabsAtTable, error: tabsError } = await supabase
      .from('tabs')
      .select('id')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('table_id', tableId)
      .in('status', ['open', 'ready_to_pay'])

    if (tabsError) {
      // Cannot establish which tabs are here, so cannot establish what is pending on them.
      // An unreadable table is not an empty one.
      console.error('[terminal/tables/close] tab lookup failed', tabsError)
      return NextResponse.json(
        {
          error: 'Could not check this table for orders awaiting review. Try again.',
          code: 'PENDING_REQUEST_CHECK_FAILED',
        },
        { status: 503 },
      )
    }

    const pending = await fetchPendingOrderRequests(supabase, {
      restaurantId: terminal.restaurantId,
      tabIds: (tabsAtTable ?? []).map((t) => String(t.id)),
      tableIds: [tableId],
    })

    /**
     * Summarised per tab AND once more for requests that name this TABLE and no tab at all.
     * `summarisePendingForTab` claims a tab-less row for whichever table it names, so passing
     * `null` as the tab id collects exactly the orphans — rows the per-tab pass cannot see.
     */
    const summaries = [
      ...(tabsAtTable ?? []).map((t) => summarisePendingForTab(pending, String(t.id), tableId)),
      summarisePendingForTab(pending, null, tableId),
    ]
    const blocking = summaries.filter(blocksSettlement)

    if (blocking.length > 0) {
      const count = summaries.reduce((n, s) => n + s.count, 0)
      const value = summaries.reduce((n, s) => n + s.value, 0)
      const unknown = summaries.some((s) => s.unknown)
      return NextResponse.json(
        {
          error: unknown
            ? 'Could not check this table for orders awaiting review. Try again.'
            : 'This table has orders still waiting for review. Accept or decline them before closing.',
          code: unknown ? 'PENDING_REQUEST_CHECK_FAILED' : 'PENDING_ORDER_REQUESTS',
          pending_request_count: count,
          pending_requests_value: value,
          pending_requests_unknown: unknown,
          // The ids, so staff can be taken straight to them rather than hunting a list.
          pending_request_ids: pending.rows.map((r) => String(r.id)),
          pending_requests: pending.rows.map((r) => ({
            id: String(r.id),
            placed_at: r.placed_at,
            value: pendingOrderRequestValue(r),
              /**
               * #120's RESIDUAL. The status is here so the caller can tell the two blocking states
               * apart, and it must not be dropped again:
               *
               *   waiting_review  a real round a customer placed. Staff ACCEPT or DECLINE it.
               *   accepting       the transient claim the accept route takes. If the worker died
               *                   between the claim and its release, this row is stranded, and
               *                   nothing clears it -- there is no reaper, and per #215 there
               *                   cannot be one until the claim records a timestamp.
               *
               * ONLY an `accepting` row may be offered the release action. Offering it for a
               * `waiting_review` row would let staff dismiss a round a customer really placed,
               * which is the #120 bug again from the other side.
               */
              status: r.status,
          })),
        },
        { status: unknown ? 503 : 409 },
      )
    }

    await closeTableSession({
      supabase,
      restaurantId: terminal.restaurantId,
      tableId,
      closedBy: terminal.terminalId,
      source: 'terminal',
    })

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tables/close]', err)
    return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
  }
}
