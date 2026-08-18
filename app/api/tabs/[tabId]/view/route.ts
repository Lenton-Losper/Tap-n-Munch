import { NextResponse } from 'next/server'
import { tabIsCurrentSession } from '@/lib/guest-orders/session-boundary'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createTabMemberKeyDeriver, redactTabMembers } from '@/lib/tab-member-key'
import {
  TAB_PENDING_REQUEST_COLUMNS,
  TAB_PENDING_REQUEST_STATUSES,
  TAB_TOTAL_ORDER_COLUMNS,
  computeTabFigures,
} from '@/lib/tabs/tab-outstanding'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tabs/[tabId]/view?restaurantId=…&sessionId=…&sessionId=…
 *
 * The redacting read of a single tab, for the guest screens (#262).
 *
 * WHY IT EXISTS. contexts/tab-context.tsx loadTab and lib/tab-session.ts fetchTabById both read
 * `tabs` through the browser anon client and both name `members` in the select list. That
 * column holds every diner's `session_id`, the anon policy carries no restaurant scope, and a
 * session_id is a credential (fetchGuestOrdersBySession looks orders up by it). Neither screen
 * wants the credential: they want to print a diner's NAME next to that diner's orders. So the
 * read moves here, runs as service_role, and hands back an opaque per-tab `member_key` in place
 * of `session_id` (lib/tab-member-key.ts). The same derivation is applied to
 * `orders.member_session_id` on the way out of lib/guest-orders/queries.ts, so the join the
 * screens already do still resolves.
 *
 * WHY IT IS UNAUTHENTICATED. Exactly the argument GET /api/tabs/active already makes, and no
 * more: this returns a strict SUBSET of what the same caller can read today with nothing but
 * the published anon key and the tab UUID it already holds in localStorage. Adding a session
 * token requirement here would be a behaviour change, not a hardening -- loadTab runs on every
 * /menu route, fetchWithSession redirects to the landing page on 410, and a guest whose token
 * had not been minted yet would be bounced out of a live tab. GET /api/tabs/[tabId] is the
 * session-token-guarded read and keeps that guard.
 *
 * WHY restaurant_id IS MATCHED RAW. Both callers pass the `restaurantId` path segment straight
 * into `.eq('restaurant_id', …)` today, so a slug that never resolved to a UUID returned no row
 * and the screen redirected. Resolving it here (as /api/tabs/active does, because the QR URL is
 * its only input) would start returning rows where the client used to get none. Same filter,
 * same outcome.
 *
 * RESPONSE. `{ tab: null }`, or `{ tab: {…, members: [{ display_name, joined_at, member_key }] },
 * self_member_keys: string[] }`. Do not add `session_id` back in any shape -- the anon grant is
 * being narrowed to match, and nothing else re-widens it.
 */

/**
 * The union of the two select lists this replaces (contexts/tab-context.tsx loadTab and
 * lib/tab-session.ts fetchTabById), minus `members`, which is fetched separately below and
 * never returned raw. Kept as the union rather than trimmed to what is demonstrably rendered:
 * every one of these is already anon-readable, so returning them is not new exposure, while
 * dropping one would be a silent behaviour change in a screen that reads it.
 */
const TAB_VIEW_COLUMNS =
  'id, restaurant_id, table_id, table_number, status, settled_type, total, payment_preference, ready_to_pay_at, pin_required, session_version, created_at, firebase_id'

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

    // Repeated params, not a comma-joined value: the customer app mints two session ids in two
    // storages and nothing syncs them (see lib/guest-orders/queries.ts fetchGuestOrdersBySession
    // for the full account), so the caller sends every id it holds.
    const sessionIds = [
      ...new Set(
        url.searchParams
          .getAll('sessionId')
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ]

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('tabs')
      .select(`${TAB_VIEW_COLUMNS}, members`)
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ tab: null, self_member_keys: [] })
    }

    /**
     * THE SESSION BOUNDARY. Same defect as My Orders, and this is the MONEY surface — it serves
     * the two figures a customer is asked to settle.
     *
     * `close_table_session` settles the table's tabs and bumps
     * `restaurant_tables.current_session_version`, leaving the old tab behind at the old version.
     * This route never checked, so a phone that kept its session id across a close could read the
     * previous party's figures.
     *
     * 410, matching what `requireSessionToken` answers for an ended session, so a client that
     * already handles "your dining session has ended" handles this too rather than meeting a shape
     * it has never seen.
     */
    if (!(await tabIsCurrentSession(supabase, normalizedTabId))) {
      return NextResponse.json(
        {
          error: 'Your dining session has ended. Please scan the QR code to start a new order.',
          reason: 'session_version_mismatch',
        },
        { status: 410 },
      )
    }

    const row = data as Record<string, unknown>
    const { members: _rawMembers, ...safeColumns } = row
    void _rawMembers

    // Derived for the CALLER'S OWN ids whether or not they are in members[] yet. The screens use
    // it two ways -- to mark a member row as "you", and, when the tab has no members array at
    // all, to recognise the caller's own orders after their member_session_id has been mapped.
    // Only the second works if this is limited to ids that matched a member row.
    const deriveSelf = sessionIds.length ? await createTabMemberKeyDeriver(normalizedTabId) : null
    const selfMemberKeys: string[] = []
    if (deriveSelf) {
      for (const sessionId of sessionIds) {
        const key = await deriveSelf(sessionId)
        if (key) selfMemberKeys.push(key)
      }
    }

    /**
     * THE AUTHORITATIVE TAB TOTAL, computed here rather than read off `tabs.total`.
     *
     * RULED 2026-08-15. `tabs.total` is a cache with five writers and two incompatible
     * definitions (see lib/tabs/tab-outstanding.ts), so it is demoted to display-only and this
     * is what every customer surface must render. Computed in ONE place, on the read every guest
     * tab screen already makes, so there is no second round trip and no client sum anywhere.
     *
     * Failing the whole request on a sum error would blank a screen that renders fine without
     * the figure, so the error is surfaced as a NULL rather than swallowed as a zero -- a zero
     * is a number a customer would believe.
     */
    const [{ data: tabOrders, error: ordersError }, { data: tabRequests, error: requestsError }] =
      await Promise.all([
        supabase.from('orders').select(TAB_TOTAL_ORDER_COLUMNS).eq('tab_id', normalizedTabId),
        supabase
          .from('order_requests')
          .select(TAB_PENDING_REQUEST_COLUMNS)
          .eq('tab_id', normalizedTabId)
          .in('status', [...TAB_PENDING_REQUEST_STATUSES]),
      ])

    if (ordersError) console.error('[TABS] payable total query failed', ordersError)
    if (requestsError) console.error('[TABS] pending total query failed', requestsError)

    const figures = computeTabFigures(tabOrders, tabRequests)
    const payableTotal = ordersError ? null : figures.payable
    const pendingTotal = requestsError ? null : figures.pending

    return NextResponse.json({
      tab: {
        ...safeColumns,
        members: await redactTabMembers(normalizedTabId, row.members),
        /**
         * `total` above is the CACHE and is knowingly wrong on some rows. It stays in the
         * response only because staff-facing callers still read it; no customer surface may.
         *
         * TWO FIGURES, never one. `payable_total` is what settlement charges and the only figure a
         * decision may use; `pending_total` is money the customer has committed to that the
         * restaurant has not answered yet. A screen that shows only payable tells a customer who
         * has just ordered N$132 that they owe nothing, which is how this was found.
         *
         * NULL on either means the sum could not be taken. Render nothing rather than zero — a
         * zero is a number a customer would act on.
         */
        payable_total: payableTotal,
        pending_total: pendingTotal,
      },
      self_member_keys: selfMemberKeys,
    })
  } catch (err) {
    console.error('[TABS] tab view error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
