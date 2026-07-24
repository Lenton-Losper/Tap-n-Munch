import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getPaymentProjections,
  sumDistinctRefundedAmounts,
  type PaymentStatus,
} from '@/lib/payments/get-payment-projection'
import {
  calendarDateRangeToUtcIso,
  DEFAULT_REPORT_TIMEZONE,
} from '@/lib/reports/format-report-datetime'

export interface ReportOrder {
  order_number: number
  placed_at: string
  table_number: number | null
  customer_name: string | null
  items: string
  total: number
  payment_method: string | null
  payment_channel: string | null
  status: string
  /** Derived from payment_events; null when no SALE row exists for this order. */
  paymentStatus: PaymentStatus | null
  refundedAmount: number
}

export interface ReportData {
  restaurant: {
    id: string
    name: string
    logo_url: string | null
    /** IANA timezone used when formatting export timestamps (PDF/CSV). */
    timezone: string
  }
  filters: {
    startDate: string
    endDate: string
    tableNumber?: number
    status?: string
  }
  summary: {
    totalRevenue: number
    totalOrders: number
    averageOrderValue: number
  }
  orders: ReportOrder[]
  generatedAt: string
}

export interface GetReportDataParams {
  restaurantId: string
  startDate: string    // YYYY-MM-DD
  endDate: string      // YYYY-MM-DD
  tableNumber?: number
  status?: string
}

export async function getReportData(params: GetReportDataParams): Promise<ReportData> {
  const supabase = createServerSupabaseClient()

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id, name, logo_url, timezone')
    .eq('id', params.restaurantId)
    .single()

  if (restaurantError || !restaurant) {
    throw new Error('Restaurant not found')
  }

  const timezone =
    typeof restaurant.timezone === 'string' && restaurant.timezone.trim()
      ? restaurant.timezone.trim()
      : DEFAULT_REPORT_TIMEZONE

  const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso(
    params.startDate,
    params.endDate,
    timezone,
  )

  let query = supabase
    .from('orders')
    .select('id, order_number, placed_at, table_number, customer_name, status, payment_method, payment_channel, payment_status, total, items')
    .eq('restaurant_id', params.restaurantId)
    .neq('status', 'cancelled')
    .gte('placed_at', startIso)
    .lt('placed_at', endIsoExclusive)
    .order('placed_at', { ascending: false })

  if (params.tableNumber) {
    query = query.eq('table_number', params.tableNumber)
  }
  if (params.status && params.status !== 'All') {
    query = query.eq('status', params.status)
  }

  const { data: rawOrders, error: ordersError } = await query
  if (ordersError) throw new Error(ordersError.message)

  const orderIds = (rawOrders ?? []).map((o: { id: string }) => String(o.id))
  const projections = await getPaymentProjections(
    supabase,
    params.restaurantId,
    orderIds,
  )

  const orders: ReportOrder[] = (rawOrders ?? []).map((o: any) => {
    const itemList = Array.isArray(o.items) ? o.items : []
    const itemsSummary = itemList
      .map((item: any) =>
        item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name
      )
      .join(', ')

    const projection = projections.get(String(o.id)) ?? null

    return {
      order_number: o.order_number,
      placed_at: o.placed_at,
      table_number: o.table_number ?? null,
      customer_name: o.customer_name ?? null,
      items: itemsSummary,
      total: Number(o.total ?? 0),
      payment_method: o.payment_method ?? null,
      payment_channel: o.payment_channel ?? null,
      status: o.status,
      paymentStatus: projection?.paymentStatus ?? null,
      refundedAmount: projection?.refundedAmount ?? 0,
    }
  })

  const paidOrders = (rawOrders ?? []).filter((o: any) => o.payment_status === 'paid')
  const grossPaid = paidOrders.reduce((sum, o: any) => sum + Number(o.total ?? 0), 0)
  const refundedDistinct = sumDistinctRefundedAmounts(
    paidOrders.map((o: any) => String(o.id)),
    projections,
  )
  const totalRevenue = grossPaid - refundedDistinct
  const totalOrders = paidOrders.length
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      logo_url: restaurant.logo_url ?? null,
      timezone,
    },
    filters: {
      startDate: params.startDate,
      endDate: params.endDate,
      tableNumber: params.tableNumber,
      status: params.status,
    },
    summary: {
      totalRevenue,
      totalOrders,
      averageOrderValue,
    },
    orders,
    generatedAt: new Date().toISOString(),
  }
}
