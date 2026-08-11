import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { ACTIVE_TAB_STATUSES, isActiveTabStatus } from '@/lib/tab-status'

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

    // Same normalisations the landing page used to apply to the raw row, so its rendered
    // state is unchanged by the move.
    return NextResponse.json({
      tab: {
        id: String(row.id),
        status: String(row.status || 'open'),
        total: Number(row.total) || 0,
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
