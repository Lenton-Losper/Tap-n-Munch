/**
 * #120 — AN UN-ACCEPTED ROUND IS INVISIBLE TO THE TERMINAL, AND SETTLE CAN MISS PART OF THE BILL.
 *
 * THE SCENARIO, from the 2026-08-01 audit and still reachable on production SHA `84e14e4`:
 * a customer orders a round at 20:15, staff have not pressed Accept, staff settle at 20:20. That
 * round is not on the bill, is never marked paid, and when it is finally accepted it RE-INFLATES
 * a tab that has already been paid and closed.
 *
 * MEASURED, all three routes that can close a bill:
 *
 *     app/api/terminal/tables/route.ts                   order_requests = 0 occurrences
 *     app/api/terminal/tabs/[tabId]/settle/route.ts      order_requests = 0 occurrences
 *     app/api/terminal/tables/[tableId]/close/route.ts   order_requests = 0 occurrences
 *
 * `unpaid_total` and `can_close` are computed from `orders` alone. A waiting-review round is not
 * in `orders` AT ALL — which is why the sibling hardening against cancelled orders (the comment at
 * terminal/tables/route.ts:140) does not touch this. A cancelled order is a row in `orders` with
 * the wrong status; this is no row at all.
 *
 * ============================================================================================
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ============================================================================================
 *
 * IT DOES NOT ADD PENDING REQUEST MONEY TO `unpaid_total`. That number is what staff are about to
 * charge, and an un-accepted request is not owed yet — nobody has agreed to make it. Rolling it in
 * would have the terminal take money for a round the kitchen may still decline. The count and the
 * value are reported SEPARATELY so the device can say "there is something else here" without
 * anyone charging for it.
 *
 * IT DOES NOT ACCEPT, DECLINE OR MODIFY ANYTHING. The resolution is a human pressing Accept or
 * Decline on the staff dashboard. This only makes the situation visible and refuses to let the
 * table be closed over the top of it.
 *
 * ============================================================================================
 * FAIL CLOSED — read this before using the result
 * ============================================================================================
 *
 * `failed` is not an error to log and move past. It is the answer "I DO NOT KNOW whether this tab
 * has pending requests", and the only safe reading of that is the same as "yes".
 *
 * This is the shape #104 got wrong in the other direction and the settle route already fixed once:
 * an errored read yielded an empty array, which read as "nothing outstanding", which let staff
 * close a table that still owed money. A read that fails must never be indistinguishable from a
 * read that found nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * order_requests statuses that are still undecided.
 *
 * `accepting` is the transient claim `app/api/order-requests/[requestId]/accept/route.ts` takes
 * before the `orders` row exists, and it belongs here for the reason it belongs in
 * ACTIVE_ORDER_STATUSES: a request in that window has not been accepted, has not been declined,
 * and is emphatically not gone. It is also the WORST case for #120 — the accept is in flight, so
 * an `orders` row is about to appear on a tab someone is settling right now.
 *
 * ONE HOME. `lib/guest-orders/queries.ts` imports this rather than keeping its own copy; it had
 * the only previous definition. Restating a status vocabulary is how the two halves of a system
 * come to disagree about what is live — this project's recurring defect class.
 */
export const LIVE_REQUEST_STATUSES = ['waiting_review', 'accepting'] as const

export type PendingOrderRequestRow = {
  id: string
  tab_id: string | null
  table_id: string | null
  table_number: number | null
  status: string | null
  total: number | null
  total_reviewed: number | null
  placed_at: string | null
}

export type PendingOrderRequestLookup = {
  /** Every undecided request found, deduplicated by id across both queries. */
  rows: PendingOrderRequestRow[]
  /**
   * TRUE means the question could not be answered. Treat it as "there ARE pending requests":
   * refuse the close, report `can_close: false`. Never as zero.
   */
  failed: boolean
}

/**
 * What this request would cost if it were accepted right now.
 *
 * `total_reviewed` wins when present: staff editing a request during review recalculates through
 * `calculateOrderPricing` into the `*_reviewed` columns, and `total` keeps the customer's original
 * submission untouched as an audit trail. Reading `total` after a review edit reports a figure
 * nobody will ever be charged.
 */
export function pendingOrderRequestValue(row: {
  total?: number | null
  total_reviewed?: number | null
}): number {
  const reviewed = Number(row.total_reviewed)
  if (row.total_reviewed != null && Number.isFinite(reviewed)) return reviewed
  const original = Number(row.total)
  return Number.isFinite(original) ? original : 0
}

/**
 * Undecided requests attached to any of these tabs, or sitting at any of these tables.
 *
 * BOTH KEYS, because `order_requests.tab_id` IS NULLABLE. `app/api/orders/route.ts:443` writes
 * `tab_id: normalizedTabId || null`, so a table-channel submission made before a tab existed —
 * or a kiosk one — carries only `table_id`. Asking by tab alone would miss exactly the round that
 * is hardest to see, which is the one #120 is about.
 *
 * TWO QUERIES, NOT ONE `.or()`. PostgREST parses the `.or()` string; `.eq()` and `.in()` are
 * parser-free. `tableIds` reaches this function from a URL path parameter, and a caller-controlled
 * value inside a parsed filter expression is the #242 / #254 defect class. The fix is to
 * REFORMULATE so no parser sees the input, not to sanitise it — so the union happens here, in
 * JavaScript, over two filters that cannot be escaped out of.
 */
export async function fetchPendingOrderRequests(
  supabase: SupabaseClient,
  params: {
    restaurantId: string
    tabIds?: Array<string | null | undefined>
    tableIds?: Array<string | null | undefined>
  },
): Promise<PendingOrderRequestLookup> {
  const restaurantId = String(params.restaurantId || '').trim()
  const tabIds = [...new Set((params.tabIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))]
  const tableIds = [...new Set((params.tableIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))]

  if (!restaurantId) {
    // No scope means every filter below is unbounded. Refuse rather than answer.
    return { rows: [], failed: true }
  }
  if (tabIds.length === 0 && tableIds.length === 0) {
    // Nothing to ask about. This is a genuine zero, not an unknown.
    return { rows: [], failed: false }
  }

  const COLUMNS = 'id, tab_id, table_id, table_number, status, total, total_reviewed, placed_at'
  const byId = new Map<string, PendingOrderRequestRow>()
  let failed = false

  const run = async (column: 'tab_id' | 'table_id', values: string[]) => {
    if (values.length === 0) return
    const { data, error } = await supabase
      .from('order_requests')
      .select(COLUMNS)
      .eq('restaurant_id', restaurantId)
      .in(column, values)
      .in('status', [...LIVE_REQUEST_STATUSES])

    if (error) {
      console.error('[pending-order-requests] read failed', { column, error })
      failed = true
      return
    }
    for (const row of (data ?? []) as unknown as PendingOrderRequestRow[]) {
      const id = String(row?.id ?? '').trim()
      if (id) byId.set(id, row)
    }
  }

  await run('tab_id', tabIds)
  await run('table_id', tableIds)

  return { rows: [...byId.values()], failed }
}

export type PendingRequestSummary = {
  count: number
  value: number
  /** True when the count could not be established. Callers must treat it as blocking. */
  unknown: boolean
}

/**
 * Summarise a lookup for one tab sitting at one table.
 *
 * TWO WAYS A ROW BELONGS HERE, and the second is the one that gets forgotten:
 *   its `tab_id` is this tab;
 *   OR it has NO `tab_id` and its `table_id` is this table.
 *
 * The second clause is not defensive padding. `app/api/orders/route.ts:443` writes
 * `tab_id: normalizedTabId || null`, so a round submitted at a table before the tab existed
 * carries only `table_id` — and matching on tab alone would drop precisely the request nothing
 * else in the system can see. A row that names a DIFFERENT tab is never claimed here, whatever
 * table it sits at.
 *
 * `failed` propagates as `unknown`, never as a zero count.
 */
export function summarisePendingForTab(
  lookup: PendingOrderRequestLookup,
  tabId: string | null | undefined,
  tableId?: string | null,
): PendingRequestSummary {
  const wantTab = String(tabId ?? '').trim()
  const wantTable = String(tableId ?? '').trim()
  const mine = lookup.rows.filter((r) => {
    const rowTab = String(r.tab_id ?? '').trim()
    if (rowTab) return Boolean(wantTab) && rowTab === wantTab
    return Boolean(wantTable) && String(r.table_id ?? '').trim() === wantTable
  })
  return {
    count: mine.length,
    value: mine.reduce((sum, r) => sum + pendingOrderRequestValue(r), 0),
    unknown: lookup.failed,
  }
}

/**
 * The single question every settle and close path should ask.
 *
 * `unknown` blocks as hard as a real count does — that is the whole fail-closed contract, stated
 * once here so no caller has to remember to `|| failed` at each site.
 */
export function blocksSettlement(summary: PendingRequestSummary): boolean {
  return summary.unknown || summary.count > 0
}

/**
 * THE CLOSE GUARD, in one place, because there are TWO close routes.
 *
 *   app/api/terminal/tables/[tableId]/close   the terminal
 *   app/api/tables/[tableNumber]/close        the staff dashboard
 *
 * #120 guarded the first and not the second, and the gap survived because the rule was written
 * INSIDE a route rather than beside the data it protects. The dashboard went on closing tables over
 * undecided rounds — the exact "silently missing from the bill, then re-inflates a closed tab" case
 * the issue was filed about — on the surface staff use most.
 *
 * Both routes now call this. They differ in how they authenticate and in how they find the table's
 * id; they must not differ in what blocks a close.
 *
 * FAILS CLOSED, AND THE TWO FAILURES ARE DIFFERENT FACTS. An unreadable tabs list is not an empty
 * one: it answers 503 with `PENDING_REQUEST_CHECK_FAILED` so a caller retries, rather than 200 with
 * a table closed over money.
 */
export type CloseGuardVerdict =
  | { blocked: false }
  | { blocked: true; status: number; body: Record<string, unknown> }

export async function guardTableClose(
  supabase: {
    from: (table: string) => any
  },
  params: { restaurantId: string; tableId: string },
): Promise<CloseGuardVerdict> {
  /**
   * Scoped by restaurant AND table, both `.eq()` — parser-free. A caller-controlled value inside a
   * PostgREST `.or()` expression is this project's #242 / #254 defect class.
   */
  const { data: tabsAtTable, error: tabsError } = await supabase
    .from('tabs')
    .select('id')
    .eq('restaurant_id', params.restaurantId)
    .eq('table_id', params.tableId)
    .in('status', ['open', 'ready_to_pay'])

  if (tabsError) {
    console.error('[guardTableClose] tab lookup failed', tabsError)
    return {
      blocked: true,
      status: 503,
      body: {
        error: 'Could not check this table for orders awaiting review. Try again.',
        code: 'PENDING_REQUEST_CHECK_FAILED',
      },
    }
  }

  const pending = await fetchPendingOrderRequests(supabase as never, {
    restaurantId: params.restaurantId,
    tabIds: (tabsAtTable ?? []).map((t: { id: unknown }) => String(t.id)),
    tableIds: [params.tableId],
  })

  /**
   * Summarised per tab AND once more for requests that name this TABLE and no tab at all.
   * `summarisePendingForTab` claims a tab-less row for whichever table it names, so passing `null`
   * as the tab id collects exactly the orphans — rows the per-tab pass cannot see.
   */
  const summaries = [
    ...(tabsAtTable ?? []).map((t: { id: unknown }) => summarisePendingForTab(pending, String(t.id), params.tableId)),
    summarisePendingForTab(pending, null, params.tableId),
  ]
  if (!summaries.filter(blocksSettlement).length) return { blocked: false }

  const count = summaries.reduce((n, s) => n + s.count, 0)
  const value = summaries.reduce((n, s) => n + s.value, 0)
  const unknown = summaries.some((s) => s.unknown)
  return {
    blocked: true,
    status: unknown ? 503 : 409,
    body: {
      error: unknown
        ? 'Could not check this table for orders awaiting review. Try again.'
        : 'This table has orders still waiting for review. Accept or decline them before closing.',
      code: unknown ? 'PENDING_REQUEST_CHECK_FAILED' : 'PENDING_ORDER_REQUESTS',
      pending_request_count: count,
      pending_requests_value: value,
      pending_requests_unknown: unknown,
      pending_request_ids: pending.rows.map((r) => String(r.id)),
      pending_requests: pending.rows.map((r) => ({
        id: String(r.id),
        placed_at: r.placed_at,
        value: pendingOrderRequestValue(r),
        /**
         * ONLY an `accepting` row may be offered the release action. A `waiting_review` row is a
         * real round a customer placed; offering to dismiss one is #120's bug from the other side.
         */
        status: r.status,
      })),
    },
  }
}
