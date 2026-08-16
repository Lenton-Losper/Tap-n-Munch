import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'
import { createTabMemberKeyDeriver, redactTabMembers } from '@/lib/tab-member-key'
import { owesMoney } from '@/lib/payments/payment-integrity'
import {
  TAB_PENDING_REQUEST_COLUMNS,
  TAB_PENDING_REQUEST_STATUSES,
  TAB_TOTAL_ORDER_COLUMNS,
  computeTabFigures,
  isSettlementArtefact,
} from '@/lib/tabs/tab-outstanding'
import { buildTabOrderGroups } from '@/lib/tabs/tab-order-groups'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tabs/[tabId]/orders?restaurantId=…&sessionId=…&sessionId=…
 *
 * EVERY order on this table, grouped by the diner who placed it. Redesign spec sections 24-26.
 *
 * WHY A NEW ROUTE RATHER THAN WIDENING AN EXISTING ONE — the load-bearing decision here.
 *
 * The obvious place was the tab `view` route. It already reads every order on the tab
 * (service_role, `.eq('tab_id', …)`) to compute the two figures, and then throws the rows away.
 * Adding the lines there would have cost nothing.
 *
 * It is the wrong place because the `view` route is deliberately UNAUTHENTICATED, and its own
 * docblock argues why: it returns a strict subset of what the published anon key already exposes,
 * and
 * requiring a token would bounce a guest whose token has not been minted yet out of a live tab.
 * That argument holds for a total and a list of first names. It does NOT hold for what everybody
 * at the table ate: today, anyone holding the tab UUID — which travels in a `?tabId=` URL that
 * `tab-context.tsx` adopts into localStorage without validating it — can read the total and the
 * display names. Publishing the item lines to the same caller is a genuine widening, not a
 * subset, so it goes behind the session token instead.
 *
 * That is Rule 7 read in reverse: the cheap change is cheap because it reuses a query, and what
 * it would actually have changed is who can read the answer.
 *
 * WHAT THIS GRANTS: reading. Nothing else. Spec section 25 — tab visibility is not edit
 * ownership. `is_self` in the response is a rendering hint derived from the caller's own ids; the
 * edit affordance is still gated client-side on `ownsOrder` against the ids the browser holds,
 * and `POST/PATCH/DELETE /api/guest/orders/[orderId]/edit` still authorises on session id
 * against `session_id` / `member_session_id` and answers a non-owner with 404. Nothing in this
 * file is consulted by any write path.
 *
 * WHAT NEVER LEAVES: `session_id`, raw `member_session_id`, `edit_lock_token`. The response is
 * BUILT from a whitelist rather than spread from the row, for the same reason
 * `redactTabMembers` is a whitelist — a column added to `orders` later must not start travelling
 * to other diners because nobody remembered this route existed.
 *
 * MONEY. `payable` and `pending` per member are summed here, server-side, from the same rows and
 * with the same imported predicates the authoritative totals use (`owesMoney`,
 * `isSettlementArtefact`, `effectiveRequestPricing`). `totals` is `computeTabFigures` over the
 * whole tab — NOT the sum of the member figures — so the headline cannot drift from the number
 * the Ready-to-Pay button decides on. Both are returned so a caller never adds anything up.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> },
) {
  try {
    const { tabId } = await params
    const normalizedTabId = String(tabId || '').trim()
    if (!normalizedTabId) {
      return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
    }

    const url = new URL(req.url)
    const restaurantId = String(url.searchParams.get('restaurantId') || '').trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const guard = await requireSessionToken(req)
    if (guard.error) return guard.error

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const mismatch = assertSessionMatchesResource(guard, {
      restaurantId: restaurantUuid,
      tabId: normalizedTabId,
    })
    if (mismatch) return mismatch

    const supabase = createServerSupabaseClient()

    const { data: tabRow, error: tabError } = await supabase
      .from('tabs')
      .select('id, restaurant_id, status, members')
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (tabError) {
      return NextResponse.json({ error: tabError.message }, { status: 500 })
    }
    if (!tabRow) {
      // Same shape as /view: a tab that is not there is not an error the screen can act on.
      return NextResponse.json({ tab_id: normalizedTabId, members: [], unattributed: null, totals: null })
    }

    /**
     * The caller's own member keys, derived from the ids the browser sent. Repeated `sessionId`
     * params, not a comma-joined value — the customer app mints two ids in two storages and
     * nothing syncs them (#278).
     */
    const sessionIds = [
      ...new Set(
        url.searchParams
          .getAll('sessionId')
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ]

    const derive = await createTabMemberKeyDeriver(normalizedTabId)
    const selfMemberKeys: string[] = []
    for (const sessionId of sessionIds) {
      const key = await derive(sessionId)
      if (key) selfMemberKeys.push(key)
    }

    /**
     * The order columns. `TAB_TOTAL_ORDER_COLUMNS` is spread in rather than restated so this
     * cannot select less than the totals need; the rest is what a line needs to render.
     *
     * `edit_lock_token` is NOT selected. It is a capability (whoever holds it can commit an
     * edit), `redactGuestOrderRow` exists to strip it from guest reads, and the surest way not
     * to leak it from a NEW route is never to fetch it.
     */
    const ORDER_LINE_COLUMNS = `id, status, order_number, items, member_session_id, session_id, placed_at, created_at, ${TAB_TOTAL_ORDER_COLUMNS}`
    const REQUEST_LINE_COLUMNS = `id, member_session_id, session_id, created_at, ${TAB_PENDING_REQUEST_COLUMNS}`

    const [{ data: orderRows, error: ordersError }, { data: requestRows, error: requestsError }] =
      await Promise.all([
        supabase.from('orders').select(ORDER_LINE_COLUMNS).eq('tab_id', normalizedTabId),
        supabase
          .from('order_requests')
          .select(REQUEST_LINE_COLUMNS)
          .eq('tab_id', normalizedTabId)
          .in('status', [...TAB_PENDING_REQUEST_STATUSES]),
      ])

    /**
     * A query error is surfaced as a NULL figure, never as a zero — the same rule /view applies.
     * A zero is a number a customer would act on; an em dash is not.
     */
    if (ordersError) console.error('[TABS] shared tab order query failed', ordersError)
    if (requestsError) console.error('[TABS] shared tab request query failed', requestsError)

    const orders = ordersError ? [] : (orderRows ?? [])
    const requests = requestsError ? [] : (requestRows ?? [])

    /** Derive the member key on the way out. The raw id never reaches buildTabOrderGroups. */
    const mapMemberKey = async (rows: Record<string, unknown>[]) => {
      const out: Record<string, unknown>[] = []
      for (const row of rows) {
        const sid = String(row.member_session_id ?? '').trim() || String(row.session_id ?? '').trim()
        const { session_id: _sid, ...rest } = row
        void _sid
        out.push({ ...rest, member_session_id: sid ? await derive(sid) : '' })
      }
      return out
    }

    const groups = buildTabOrderGroups({
      members: await redactTabMembers(normalizedTabId, tabRow.members),
      selfMemberKeys,
      orders: await mapMemberKey(orders as Record<string, unknown>[]),
      requests: await mapMemberKey(requests as Record<string, unknown>[]),
      owesMoney,
      isSettlementArtefact: (row) => isSettlementArtefact(row as never),
    })

    /**
     * The headline, over the WHOLE tab, from the same function every other surface uses. Not the
     * sum of the member figures: if those two can ever disagree, the disagreement must be
     * visible rather than hidden by deriving one from the other.
     */
    const figures = computeTabFigures(orders as never, requests as never)

    return NextResponse.json({
      tab_id: normalizedTabId,
      tab_status: String(tabRow.status ?? ''),
      members: groups.members,
      unattributed: groups.unattributed.orders.length > 0 ? groups.unattributed : null,
      totals: {
        payable: ordersError ? null : figures.payable,
        pending: requestsError ? null : figures.pending,
      },
    })
  } catch (err) {
    console.error('[TABS] shared tab orders error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
