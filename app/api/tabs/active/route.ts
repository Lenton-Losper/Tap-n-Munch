import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { ACTIVE_TAB_STATUSES, isActiveTabStatus } from '@/lib/tab-status'
/**
 * F7. The figure is DERIVED from the orders, never read off `tabs.total`.
 *
 * `loadTabTotals` returns numbers and no order id, which is what keeps this route inside the
 * AGGREGATE_NO_IDS class in the guest-route manifest — see the note at the query below.
 */
import { centsToMajor, loadTabTotals } from '@/lib/orders/order-financials'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tabs/active?restaurantId=…&tableNumber=…
 *
 * The unauthenticated "is a tab already open at this table?" lookup for the QR landing page
 * (app/menu/[restaurantId]/v2/page.tsx). It exists so that page stops reading `tabs` directly
 * under the anon key.
 *
 * #262: the anon SELECT grant on `public.tabs` covers `members`, and the policy carries no
 * restaurant scope — so anyone holding the published anon key could list every member's
 * `session_id` on every open tab in every restaurant, and a session_id is a credential
 * (lib/tab-session.ts fetchGuestOrdersBySession fetches a diner's orders by it). The landing
 * page only ever needed a COUNT, so this route runs the query as service_role and returns the
 * count instead of the array. Nothing here is newly exposed: all five values are already
 * rendered on the unauthenticated landing to anybody who scans that table's QR code.
 *
 * Response is exactly `{ tab: null }` or `{ tab: { id, status, total, pin_required,
 * member_count } }`. Do not widen it — the anon grant is being narrowed to match.
 */

/**
 * The landing page has always ignored tabs older than 12 hours (#211: a walk-up must not be
 * offered yesterday's abandoned tab). Reproduced here byte for byte; changing it changes the
 * stale-tab behaviour that ruling settled.
 */
const LANDING_TAB_CUTOFF_MS = 12 * 60 * 60 * 1000

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const restaurantIdInput = String(url.searchParams.get('restaurantId') || '').trim()
    const tableNumber = Number(url.searchParams.get('tableNumber'))

    if (!restaurantIdInput) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ error: 'Invalid table number' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantIdInput).catch(() => null)
    if (!restaurantUuid) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    }

    const supabase = createServerSupabaseClient()

    // The landing page filtered on `table_id` when its own restaurant_tables lookup had
    // resolved a row (active rows only, via getSupabaseTableByNumber) and fell back to
    // `table_number` when it had not. Same two branches, resolved here instead so the caller
    // needs nothing but the restaurant and table number off the QR URL.
    const { data: tableRow } = await supabase
      .from('restaurant_tables')
      .select('id')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', tableNumber)
      .eq('active', true)
      .maybeSingle()

    const cutoffIso = new Date(Date.now() - LANDING_TAB_CUTOFF_MS).toISOString()

    let tabQuery = supabase
      .from('tabs')
      .select('id, status, total, pin_required, members')
      .eq('restaurant_id', restaurantUuid)
      .in('status', [...ACTIVE_TAB_STATUSES])
      .gte('created_at', cutoffIso)

    const tableId = String(tableRow?.id || '').trim()
    tabQuery = tableId
      ? tabQuery.eq('table_id', tableId)
      : tabQuery.eq('table_number', tableNumber)

    const { data: candidates, error } = await tabQuery.limit(1)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const row = (candidates || []).find((candidate) =>
      isActiveTabStatus(String((candidate as Record<string, unknown>)?.status || ''))
    ) as Record<string, unknown> | undefined

    if (!row) {
      return NextResponse.json({ tab: null })
    }

    /**
     * ============================================================================================
     * F7 — THE FIGURE IS DERIVED, NOT READ OFF `tabs.total`
     * ============================================================================================
     *
     * This was `Number(row.total)` — the stored column — and it is the last customer-facing reader
     * of it. The landing page renders it as "Total so far: N$x".
     *
     * `tabs.total` has not been authoritative since the 2026-08-15 ruling recorded on
     * lib/tabs/tab-outstanding.ts. It had five writers using TWO INCOMPATIBLE DEFINITIONS, and
     * measured on production that day: of 20 tabs carrying orders, the two definitions agreed on
     * ONE. Thirteen rows stored gross-ordered, six stored still-outstanding, decided by whichever
     * writer last touched the row — and seven money-changing events skip the column entirely
     * (order cancel, terminal order creation, refund, terminal payment failure, request decline,
     * table close, terminal status change). So the number a customer saw was one of two different
     * quantities, chosen by accident.
     *
     * ============================================================================================
     * WHY THIS IS AGGREGATE_NO_IDS AND NOT A WEAKENING OF #305
     * ============================================================================================
     *
     * This route was classified NO_ORDER_READ in the guest-route manifest, and reading orders here
     * moves it — deliberately, and into a class the manifest already defines for exactly this
     * shape: "reads order rows but selects no `id` column, so no order id can leave however the
     * caller is authorised. The tab view sums a bill this way."
     *
     * The property #305 is about is that no guest-reachable route hands an order id to a session
     * that does not own it. Since Sprint 2026-09-28 the orders are read by `loadTabTotals`
     * (lib/orders/order-financials.ts), which must read order ids to join each order to its lines
     * but returns a TabTotals of numbers only, built field by field; the only thing that leaves
     * this function is a NUMBER. guest-routes-do-not-leak-foreign-order-ids asserts both that this
     * route reads orders only through that boundary and that the boundary returns no id.
     *
     * NOTHING NEW IS EXPOSED. The response keeps EXACTLY the five keys this route's contract names
     * — the docblock above says "do not widen it", and it is not widened. Only the provenance of
     * `total` changes, and the aggregate was already being served to this caller.
     *
     * WHICH FIGURE. `computeTabGrossOrdered`, not `computeTabOutstanding`: the label says "Total so
     * far" — what has been ordered — and those are different questions. Putting outstanding behind
     * that label would be the same lie pointing the other way.
     *
     * A FAILED READ SERVES 0, matching what this route already did for a tab with no stored total,
     * rather than falling back to the stale column. The alternative is to keep serving a number
     * that is neither definition reliably, which is the defect.
     */
    /**
     * Sprint 2026-09-28: through the financial projection, so a voided line is no longer "ordered"
     * and a reduction is counted once. `loadTabTotals` returns numbers only (it joins lines to
     * orders by id internally and no id leaves it), which is what keeps this route
     * AGGREGATE_NO_IDS; `grossOrderedCents` is computeTabGrossOrdered's question -- everything
     * ordered, paid or not -- less what was voided.
     */
    let derivedTotal = 0
    try {
      const totals = await loadTabTotals(supabase, restaurantUuid, String(row.id))
      derivedTotal = centsToMajor(totals.grossOrderedCents)
    } catch (e) {
      console.error('[TABS] active tab: could not derive the tab total', {
        tabId: String(row.id),
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // Same normalisations the landing page used to apply to the raw row, so its rendered
    // state is unchanged by the move.
    return NextResponse.json({
      tab: {
        id: String(row.id),
        status: String(row.status || 'open'),
        total: derivedTotal,
        pin_required: row.pin_required !== false,
        member_count: Array.isArray(row.members) ? row.members.length : 0,
      },
    })
  } catch (err) {
    console.error('[TABS] active tab lookup error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
