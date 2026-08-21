import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import {
  isAuthError,
  requireUrlRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import {
  getPaymentProjections,
  sumDistinctRefundedAmounts,
} from '@/lib/payments/get-payment-projection'
import {
  calendarDateRangeToUtcIso,
  DEFAULT_REPORT_TIMEZONE,
} from '@/lib/reports/format-report-datetime'
import { preLaunchRestaurant } from '@/lib/reporting/pre-launch-restaurants'

export const dynamic = 'force-dynamic'

/**
 * #322 -- EVERY FAILURE LEAVES AS JSON.
 *
 * This handler used to have no try/catch at all, so anything thrown below it -- and
 * getPaymentProjections throws on any PostgREST error -- escaped and the worker returned a
 * ZERO-LENGTH 500. That is what shipped: a blank response, no message, nothing in the UI to read,
 * for weeks. The underlying cause is fixed (chunked filters, paginated summary), but the class of
 * failure must never be silent again, so the boundary is closed regardless of cause.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    return await loadOrderHistory(req)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[orders/history] unhandled failure', {
      url: req.url,
      error: err,
    })
    return NextResponse.json(
      {
        error: 'Could not load order history. Try a narrower date range.',
        detail: message,
      },
      { status: 500 },
    )
  }
}

async function loadOrderHistory(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const restaurantId = searchParams.get('restaurantId') || ''
  const startDate = searchParams.get('startDate') || new Date().toISOString().split('T')[0]
  const endDate = searchParams.get('endDate') || new Date().toISOString().split('T')[0]
  const tableNumber = searchParams.get('table') || ''
  const status = searchParams.get('status') || ''
  const orderNumber = searchParams.get('orderNumber') || ''
  const page = Number(searchParams.get('page') || '1')
  const pageSize = 20

  if (!restaurantId) {
    return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
  }

  const restaurantUuid = await resolveRestaurantUuid(restaurantId)

  const auth = await requireUrlRestaurantPermission(
    restaurantUuid,
    PERMISSIONS.ORDERS_READ,
    req,
  )
  if (isAuthError(auth)) return auth

  const supabase = createServerSupabaseClient()

  const { data: restaurantRow } = await supabase
    .from('restaurants')
    .select('timezone')
    .eq('id', restaurantUuid)
    .maybeSingle()

  const timezone =
    typeof restaurantRow?.timezone === 'string' && restaurantRow.timezone.trim()
      ? restaurantRow.timezone.trim()
      : DEFAULT_REPORT_TIMEZONE

  const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso(startDate, endDate, timezone)

  let query = supabase
    .from('orders')
    .select(
      'id, order_number, table_number, total, status, payment_method, payment_status, placed_at, items, member_session_id, tab_id',
      { count: 'exact' },
    )
    .eq('restaurant_id', restaurantUuid)
    .gte('placed_at', startIso)
    .lt('placed_at', endIsoExclusive)
    .order('placed_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (tableNumber) query = query.eq('table_number', Number(tableNumber))
  if (status && status !== 'all') query = query.eq('status', status)
  if (orderNumber) {
    const num = Number(orderNumber)
    if (Number.isFinite(num)) query = query.eq('order_number', num)
  }

  const { data: orders, error, count } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const tabIds = [...new Set((orders || []).map((o) => o.tab_id).filter(Boolean))]
  const tabsById: Record<string, { members?: Array<{ session_id?: string; display_name?: string }> }> = {}

  if (tabIds.length) {
    const { data: tabs } = await supabase.from('tabs').select('id, members').in('id', tabIds)
    for (const tab of tabs || []) {
      tabsById[String(tab.id)] = tab
    }
  }

  const pageOrderIds = (orders || []).map((o) => String(o.id))
  const pageProjections = await getPaymentProjections(
    supabase,
    restaurantUuid,
    pageOrderIds,
  )

  const enrichedOrders = (orders || []).map((order) => {
    let memberName = '—'
    if (order.member_session_id && order.tab_id) {
      const tab = tabsById[String(order.tab_id)]
      const member = tab?.members?.find(
        (m) => String(m.session_id) === String(order.member_session_id),
      )
      memberName = String(member?.display_name || '').trim() || 'Guest'
    }
    const projection = pageProjections.get(String(order.id)) ?? null
    return {
      ...order,
      memberName,
      paymentStatus: projection?.paymentStatus ?? null,
      refundedAmount: projection?.refundedAmount ?? 0,
    }
  })

  let summaryQuery = supabase
    .from('orders')
    .select('id, total')
    .eq('restaurant_id', restaurantUuid)
    .eq('payment_status', 'paid')
    .gte('placed_at', startIso)
    .lt('placed_at', endIsoExclusive)

  if (tableNumber) summaryQuery = summaryQuery.eq('table_number', Number(tableNumber))
  if (status && status !== 'all') summaryQuery = summaryQuery.eq('status', status)
  if (orderNumber) {
    const num = Number(orderNumber)
    if (Number.isFinite(num)) summaryQuery = summaryQuery.eq('order_number', num)
  }

  // #322 -- PAGINATED, AND THAT IS LOAD-BEARING TOO.
  //
  // This query is not the page: it is every PAID order in the window, and it feeds totalRevenue,
  // totalOrders and avgOrderValue. PostgREST caps a response at 1000 rows, so unpaginated it
  // silently truncated -- measured on staging: 1220 paid orders in the window, 1000 returned.
  // Fixing only the URI ceiling would have turned a blank 500 into a WRONG REVENUE FIGURE that
  // looks right, which is worse for a trading restaurant than an obvious failure.
  const SUMMARY_PAGE = 1000
  const summary: { id: string; total: number }[] = []
  for (let offset = 0; ; offset += SUMMARY_PAGE) {
    const { data: page, error: summaryError } = await summaryQuery.range(
      offset,
      offset + SUMMARY_PAGE - 1,
    )
    if (summaryError) throw summaryError
    const rows = (page ?? []) as typeof summary
    summary.push(...rows)
    if (rows.length < SUMMARY_PAGE) break
  }

  const summaryOrderIds = summary.map((o) => String(o.id))
  const summaryProjections = await getPaymentProjections(
    supabase,
    restaurantUuid,
    summaryOrderIds,
  )

  const grossPaid = summary.reduce((sum, o) => sum + (Number(o.total) || 0), 0)
  const refundedDistinct = sumDistinctRefundedAmounts(
    summary.map((o) => String(o.id)),
    summaryProjections,
  )
  const totalRevenue = grossPaid - refundedDistinct
  const avgOrderValue = summary.length ? totalRevenue / summary.length : 0

  /**
   * A venue that has not opened reports test data, not trade. Ruled 2026-08-21 for Riviera, whose
   * 15 orders are all owner testing and whose N$1385 of `payment_status = 'paid'` would otherwise
   * be counted as revenue by the sum above.
   *
   * FLAGGED, NOT ZEROED. The figures are withheld and the caller is told why, because a fabricated
   * 0.00 rendered in the same place as a real total is a lying instrument -- indistinguishable from
   * a venue that genuinely took nothing. `preLaunch` is what the UI branches on; the numeric fields
   * stay in the payload shape so nothing downstream has to guard for a missing key.
   *
   * NOTHING IS ALTERED UNDERNEATH. No order is cancelled, edited or hidden from the list -- the
   * orders array is untouched and every row is still there to inspect. Remove the entry from
   * PRE_LAUNCH_RESTAURANTS and every figure returns.
   */
  const preLaunch = preLaunchRestaurant(restaurantUuid)

  return NextResponse.json({
    orders: enrichedOrders,
    total: count || 0,
    page,
    pageSize,
    totalRevenue: preLaunch ? null : totalRevenue,
    totalOrders: preLaunch ? null : summary.length,
    avgOrderValue: preLaunch ? null : avgOrderValue,
    preLaunch: preLaunch ? { name: preLaunch.name, reason: preLaunch.reason } : null,
  })
}
