import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import {
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  isCardPaymentStillInFlight,
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  owesMoney,
  isPaidPaymentStatus,
  secondsSincePush,
} from '@/lib/payments/payment-integrity'
import {
  buildMemberNameLookup,
  resolveOrderMemberName,
} from '@/lib/tabs/resolve-order-member-names'
import {
  blocksSettlement,
  fetchPendingOrderRequests,
  summarisePendingForTab,
} from '@/lib/tabs/pending-order-requests'
import { loadTableOwners } from '@/lib/tables/table-owners'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    /**
     * ADR-005 §3 -- THE FLOOR GRID, BEHIND AN OPT-IN PARAM.
     *
     * The default response below is structurally incapable of showing a free table: it filters
     * `status = 'occupied'` and joins `tabs!inner`, so a table with no live tab cannot appear. A
     * waiter's floor grid needs exactly those tables, because a table you cannot see is a table
     * you cannot open.
     *
     * WHY A PARAM AND NOT A WIDENED DEFAULT. The current APK is live at three venues and renders
     * this list as "tables that need attention". Adding every free table to that response would
     * fill the existing device with cards for empty tables overnight, on a build nobody is about
     * to change. So the new shape is opt-in and the old one is untouched -- the same reasoning
     * that made `ready_to_pay_at` an additive field rather than a changed one.
     */
    const url = new URL(req.url)
    if (url.searchParams.get('view') === 'floor') {
      /**
       * ONLY THE FLOOR GRID IS GATED, NOT THIS ROUTE. The default response below is the pre-
       * existing (2026-06-26) table list the live APK at Mingle and ChowNow already depends on,
       * and it must keep working for every restaurant regardless of this flag. `?view=floor` is
       * the new ADR-005 §3 shape, added 2026-08-28, and until today an old APK not sending the
       * param was the ONLY thing keeping it from any restaurant that guessed the query string.
       */
      const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
      if (!allowed) {
        return NextResponse.json(
          { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
          { status: 403 },
        )
      }
      return await respondWithFloorGrid(supabase, terminal.restaurantId)
    }

    const { data: tables, error } = await supabase
      .from('restaurant_tables')
      /**
       * `ready_to_pay_at` is SELECTED here, not merely returned in the mapping below (#318).
       * A column that is written but never selected reaches the client as `undefined` and the
       * feature ships doing nothing — exactly how #306's fix shipped inert. The mapping cannot
       * invent what the query did not fetch.
       *
       * NOTE: this string is parsed by PostgREST, NOT by Postgres. It is not SQL and it does not
       * accept `--` comments — putting one inside the template literal breaks the query at
       * runtime, which typecheck cannot see. Comments belong out here.
       */
      .select(`
        id,
        table_number,
        status,
        tabs!inner(
          id,
          status,
          total,
          payment_preference,
          ready_to_pay_at,
          members,
          created_at,
          opened_by_user_id,
          orders(
            id,
            order_number,
            total,
            status,
            payment_status,
            terminal_pushed_at,
            items,
            placed_at,
            member_session_id,
            session_id
          )
        )
      `)
      .eq('restaurant_id', terminal.restaurantId)
      .eq('status', 'occupied')
      .in('tabs.status', ['open', 'ready_to_pay'])
      .order('table_number', { ascending: true })

    if (error) {
      console.error('[terminal/tables GET]', error)
      return NextResponse.json({ error: 'Failed to load tables' }, { status: 500 })
    }

    const allOrderIds = (tables ?? []).flatMap((table: any) => {
      const tab = table.tabs?.[0] ?? null
      const orders = tab?.orders ?? []
      return orders.map((o: any) => String(o.id)).filter(Boolean)
    })

    const projections = await getPaymentProjections(
      supabase,
      terminal.restaurantId,
      allOrderIds,
    )

    /**
     * #120. The rounds that are NOT in `orders` yet.
     *
     * Asked by tab AND by table, because `order_requests.tab_id` is nullable — see the note on
     * fetchPendingOrderRequests. One read for the whole payload rather than one per table.
     */
    const pending = await fetchPendingOrderRequests(supabase, {
      restaurantId: terminal.restaurantId,
      tabIds: (tables ?? []).map((t: any) => t.tabs?.[0]?.id),
      tableIds: (tables ?? []).map((t: any) => t.id),
    })

    // One clock for the whole response, so two orders pushed at the same moment cannot be
    // reported on opposite sides of the timeout within a single payload.
    const now = new Date()
    const cardInFlight = (order: any) =>
      isCardPaymentStillInFlight(order.payment_status, order.terminal_pushed_at, now)

    /**
     * ADR-005 §3. Additive: the existing APK ignores these fields, and a new one uses them to
     * print who has the table and how long it has been open.
     */
    const owners = await loadTableOwners(
      supabase,
      terminal.restaurantId,
      (tables ?? []).map((t: any) => String(t.id)),
    )

    // Compute canClose and unpaidTotal server-side
    const enriched = (tables ?? []).map((table: any) => {
      const tab = table.tabs?.[0] ?? null
      if (!tab) return { ...table, tab: null, canClose: false }

      /**
       * #288. The terminal renders `{item.member_name || 'Guest'}` and nothing ever sent
       * `member_name`, so every order on every table read as "Guest" -- which makes the
       * per-order "Settle Selected" flow unusable as intended, because staff cannot tell which
       * orders are whose. Resolved here from `tabs.members[]`; an unmatched order gets `null`
       * and the terminal's own fallback handles it. Never guessed.
       */
      const memberNames = buildMemberNameLookup(tab.members)

      const orders = (tab.orders ?? []).map((order: any) => {
        const projection = projections.get(String(order.id)) ?? null
        // The raw ids are NOT spread out to the terminal: `...order` below would carry them,
        // so they are stripped and replaced by the name. A session id is a credential
        // (`ownsOrder` makes knowing one the whole authorisation) and staff have no use for it.
        const { member_session_id: _m, session_id: _s, ...safeOrder } = order
        void _m
        void _s
        return {
          ...safeOrder,
          member_name: resolveOrderMemberName(order, memberNames),
          // Distinct from orders.payment_status (paid/pending settlement flag).
          payment_status_derived: projection?.paymentStatus ?? null,
          refunded_amount: projection?.refundedAmount ?? 0,
          // Per-order settlement affordances, so the terminal can render and disable the
          // cash action without duplicating the status or timeout rules client-side.
          can_settle_card: isClaimablePaymentStatus(order.payment_status),
          // Cash is blocked only while a card attempt is genuinely live; once the attempt
          // times out the button becomes available again with no staff intervention.
          can_settle_cash:
            isCashSettleablePaymentStatus(order.payment_status) ||
            (String(order.payment_status ?? '').trim().toLowerCase() === 'terminal_pending' &&
              !cardInFlight(order)),
          card_payment_in_flight: cardInFlight(order),
          card_in_flight_seconds: cardInFlight(order)
            ? Math.round(secondsSincePush(order.terminal_pushed_at, now) ?? 0)
            : null,
        }
      })
      // Everything still OWED counts, not just what a card settlement happens to be able to
      // claim. cash_pending, failed and terminal_pending orders are unpaid money; excluding
      // them understated the tab and let can_close report true over genuine debt. Cancelled
      // (and any other terminal status) still correctly falls out.
      const unpaidOrders = orders.filter((o: any) => owesMoney(o.payment_status))
      const unpaidTotal = unpaidOrders.reduce(
        (sum: number, o: any) => sum + Number(o.total), 0
      )

      /**
       * ==========================================================================================
       * ZERO OWED BECAUSE EVERYTHING WAS CANCELLED IS NOT ZERO OWED BECAUSE EVERYTHING WAS PAID.
       * ==========================================================================================
       *
       * `unpaid_total` alone cannot tell those apart, and on 2026-08-28 that cost real money.
       * Digi Cofee Table 1 had orders #30, #31 and #32 auto-cancelled by the stale-payment sweep.
       * Every one of them fell out of `unpaidOrders` — correctly, a cancelled order owes nothing —
       * so `unpaid_total` came back 0, and the terminal rendered the tab as PAID IN FULL over a
       * table where nothing had ever been paid and the kitchen had already sent the food out.
       *
       * A waiter reading "paid in full" closes the table. That is the expensive direction, so the
       * distinction is drawn HERE rather than left to each client to infer from a number that
       * genuinely does not carry it.
       *
       * `paid_order_count` is what makes "0 owed" legible: zero owed with at least one paid order
       * is a settled tab; zero owed with none is a tab where nothing was ever billed. The counts
       * are reported rather than a single verdict so a device can distinguish the states the
       * owner's signed copy actually names, instead of collapsing them again on arrival.
       *
       * Purely additive — an older APK ignores unknown fields and keeps its current behaviour.
       */
      const paidOrders = orders.filter((o: any) => isPaidPaymentStatus(o.payment_status))
      const billableOrders = orders.filter(
        (o: any) => owesMoney(o.payment_status) || isPaidPaymentStatus(o.payment_status),
      )

      /**
       * #120. A round that has not been Accepted is not in `orders` at all, so every number above
       * is blind to it. `can_close` used to be computed from `unpaidOrders` alone, which is how
       * staff could close a table over the top of a round placed five minutes earlier — leaving it
       * to re-inflate a settled, closed tab the moment someone finally pressed Accept.
       *
       * The pending value is reported ALONGSIDE `unpaid_total`, never added into it. `unpaid_total`
       * is what staff are about to charge, and nobody has agreed to make this food yet. Rolling it
       * in would have the terminal take money for a round the kitchen may still decline.
       *
       * `blocksSettlement` treats a FAILED read as blocking, not as zero — the same fail-closed
       * rule the settle route's own can_close check already learned (#104).
       */
      const pendingForTab = summarisePendingForTab(pending, tab.id, table.id)
      const canClose = unpaidOrders.length === 0 && !blocksSettlement(pendingForTab)

      return {
        id: table.id,
        table_number: table.table_number,
        status: table.status,
        tab: {
          id: tab.id,
          status: tab.status,
          total: tab.total,
          unpaid_total: unpaidTotal,
          /**
           * The three counts that make `unpaid_total: 0` readable. See the block above.
           *   paid > 0, unpaid 0            -> genuinely settled
           *   paid 0,   unpaid 0, billable 0 -> nothing was ever billed (all cancelled)
           *   order_count > billable_count   -> some orders are cancelled; say so, never "paid"
           */
          paid_order_count: paidOrders.length,
          unpaid_order_count: unpaidOrders.length,
          billable_order_count: billableOrders.length,
          order_count: orders.length,
          payment_preference: tab.payment_preference,
          /**
           * #318. The terminal's table-card chip decides "Ready to Pay" from `status` alone, and
           * every settle path reopens `status` to 'open' -- correctly, because status is the
           * ORDERING gate and the remaining diners must be able to keep ordering. So on a table of
           * four who have all asked to pay, the first person paying flipped the chip to
           * "3 unpaid orders" and nothing told staff anyone was still waiting.
           *
           * `ready_to_pay_at` now SURVIVES a partial settle when money remains (1f47752, live on
           * production), so the honest signal is `ready_to_pay_at IS NOT NULL AND unpaid_total > 0`.
           * This is the field the device needs to compute it. One column, no schema change.
           *
           * Adding it is inert on its own -- the terminal must widen its condition to read it, and
           * that ships in an APK.
           */
          ready_to_pay_at: tab.ready_to_pay_at ?? null,
          /**
           * #120. Surfaced so the device can SAY why the table will not close, instead of showing
           * a disabled button with no cause. Adding these fields is inert on its own — the
           * terminal must render them, and that ships in an APK. `can_close` above is not inert:
           * it changes today, on the current build, and that is the half that actually protects
           * the bill.
           *
           * `pending_requests_unknown` is deliberately its own field rather than being folded
           * into the count. "I could not read the table" and "there are two rounds waiting" both
           * block, but they are not the same thing to a human looking at a device.
           */
          pending_request_count: pendingForTab.count,
          pending_requests_value: pendingForTab.value,
          pending_requests_unknown: pendingForTab.unknown,
          // ADR-005 §3: how long this table has been open, and who opened it. `opened_at` is the
          // tab's own creation time, not the assignment's -- a handover must not reset the clock
          // the waiter is reading.
          opened_at: tab.created_at ?? null,
          opened_by_user_id: tab.opened_by_user_id ?? null,
          orders,
        },
        can_close: canClose,
        // Current owner of the TABLE, which can legitimately differ from the tab's opener after a
        // shift change. Null when nobody is assigned -- a QR tab, or an assignment that failed.
        owner: owners.get(String(table.id)) ?? null,
      }
    })

    return NextResponse.json({
      tables: enriched,
      // Lets the terminal show an accurate countdown without hardcoding the server's value.
      card_in_flight_timeout_seconds: CARD_IN_FLIGHT_TIMEOUT_SECONDS,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

/**
 * ADR-005 §3 -- every active table, open or free, with its owner and how long it has been open.
 *
 * OPEN/FREE IS DERIVED FROM THE TAB, NOT FROM restaurant_tables.status.
 *
 * The two disagree in production, and the disagreement is documented: #216 covers a table with a
 * live tab whose status never became 'occupied', and 20260824150000_reap_abandoned_tabs covers the
 * reverse -- a reaped tab leaving status stuck at 'occupied'. `status` is a cache of a fact that
 * lives somewhere else.
 *
 * A waiter's grid must be right about which tables are free, because a table wrongly shown as open
 * is a table nobody seats. So the live tab is the answer and `status` is reported alongside it for
 * diagnosis rather than used as the source of truth.
 */
async function respondWithFloorGrid(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
) {
  const { data: tables, error: tablesError } = await supabase
    .from('restaurant_tables')
    .select('id, table_number, table_name, status')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .order('table_number', { ascending: true })

  if (tablesError) {
    console.error('[terminal/tables GET view=floor] tables read failed', tablesError)
    return NextResponse.json({ error: 'Failed to load tables' }, { status: 500 })
  }

  const { data: tabs, error: tabsError } = await supabase
    .from('tabs')
    .select('id, table_id, status, total, created_at, opened_by_user_id')
    .eq('restaurant_id', restaurantId)
    .in('status', ['open', 'ready_to_pay'])

  if (tabsError) {
    console.error('[terminal/tables GET view=floor] tabs read failed', tabsError)
    return NextResponse.json({ error: 'Failed to load tabs' }, { status: 500 })
  }

  // If a table somehow carries two live tabs, the NEWEST wins. That is the one a waiter just
  // opened and the one they are about to add to; silently picking the older would send the round
  // onto a tab nobody is looking at.
  const tabByTableId = new Map<string, Record<string, unknown>>()
  for (const tab of (tabs ?? []) as Array<Record<string, unknown>>) {
    const tableId = String(tab.table_id ?? '').trim()
    if (!tableId) continue
    const existing = tabByTableId.get(tableId)
    if (!existing || String(tab.created_at) > String(existing.created_at)) {
      tabByTableId.set(tableId, tab)
    }
  }

  const owners = await loadTableOwners(
    supabase,
    restaurantId,
    (tables ?? []).map((t: { id: string }) => String(t.id)),
  )

  // One clock for the whole payload, so two tables opened in the same second cannot report
  // times that disagree with each other.
  const now = Date.now()

  const grid = (tables ?? []).map((table: Record<string, unknown>) => {
    const tab = tabByTableId.get(String(table.id)) ?? null
    const openedAt = tab?.created_at ? String(tab.created_at) : null
    const openedAtMs = openedAt ? new Date(openedAt).getTime() : Number.NaN

    return {
      id: String(table.id),
      table_number: table.table_number ?? null,
      table_name: table.table_name ?? null,
      state: tab ? 'open' : 'free',
      owner: owners.get(String(table.id)) ?? null,
      opened_at: openedAt,
      // Provided so the device does not have to trust its own clock against the server's, which
      // on a terminal that has been on a shelf for a week is not a safe assumption.
      seconds_open: Number.isFinite(openedAtMs)
        ? Math.max(0, Math.round((now - openedAtMs) / 1000))
        : null,
      tab: tab
        ? {
            id: String(tab.id),
            status: tab.status ?? null,
            total: tab.total ?? 0,
            opened_by_user_id: tab.opened_by_user_id ?? null,
          }
        : null,
      // Reported for diagnosis only. See the header: it is not what `state` is computed from.
      table_status: table.status ?? null,
    }
  })

  return NextResponse.json({
    tables: grid,
    server_time: new Date(now).toISOString(),
  })
}
