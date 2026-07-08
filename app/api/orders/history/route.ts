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

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
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

  let query = supabase
    .from('orders')
    .select(
      'id, order_number, table_number, total, status, payment_method, payment_status, placed_at, items, member_session_id, tab_id',
      { count: 'exact' },
    )
    .eq('restaurant_id', restaurantUuid)
    .gte('placed_at', `${startDate}T00:00:00.000Z`)
    .lte('placed_at', `${endDate}T23:59:59.999Z`)
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
    .gte('placed_at', `${startDate}T00:00:00.000Z`)
    .lte('placed_at', `${endDate}T23:59:59.999Z`)

  if (tableNumber) summaryQuery = summaryQuery.eq('table_number', Number(tableNumber))
  if (status && status !== 'all') summaryQuery = summaryQuery.eq('status', status)
  if (orderNumber) {
    const num = Number(orderNumber)
    if (Number.isFinite(num)) summaryQuery = summaryQuery.eq('order_number', num)
  }

  const { data: summary } = await summaryQuery

  const summaryOrderIds = (summary || []).map((o) => String(o.id))
  const summaryProjections = await getPaymentProjections(
    supabase,
    restaurantUuid,
    summaryOrderIds,
  )

  const grossPaid = (summary || []).reduce((sum, o) => sum + (Number(o.total) || 0), 0)
  const refundedDistinct = sumDistinctRefundedAmounts(
    (summary || []).map((o) => String(o.id)),
    summaryProjections,
  )
  const totalRevenue = grossPaid - refundedDistinct
  const avgOrderValue = summary?.length ? totalRevenue / summary.length : 0

  return NextResponse.json({
    orders: enrichedOrders,
    total: count || 0,
    page,
    pageSize,
    totalRevenue,
    totalOrders: summary?.length ?? 0,
    avgOrderValue,
  })
}
