import { createServerSupabaseClient } from '@/lib/supabase/server'

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
}

export interface ReportData {
  restaurant: {
    id: string
    name: string
    logo_url: string | null
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
    .select('id, name, logo_url')
    .eq('id', params.restaurantId)
    .single()

  if (restaurantError || !restaurant) {
    throw new Error('Restaurant not found')
  }

  let query = supabase
    .from('orders')
    .select('order_number, placed_at, table_number, customer_name, status, payment_method, payment_channel, payment_status, total, items')
    .eq('restaurant_id', params.restaurantId)
    .neq('status', 'cancelled')
    .gte('placed_at', `${params.startDate}T00:00:00.000Z`)
    .lte('placed_at', `${params.endDate}T23:59:59.999Z`)
    .order('placed_at', { ascending: false })

  if (params.tableNumber) {
    query = query.eq('table_number', params.tableNumber)
  }
  if (params.status && params.status !== 'All') {
    query = query.eq('status', params.status)
  }

  const { data: rawOrders, error: ordersError } = await query
  if (ordersError) throw new Error(ordersError.message)

  const orders: ReportOrder[] = (rawOrders ?? []).map((o: any) => {
    const itemList = Array.isArray(o.items) ? o.items : []
    const itemsSummary = itemList
      .map((item: any) =>
        item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name
      )
      .join(', ')

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
    }
  })

  const paidOrders = (rawOrders ?? []).filter((o: any) => o.payment_status === 'paid')
  const totalRevenue = paidOrders.reduce((sum, o: any) => sum + Number(o.total ?? 0), 0)
  const totalOrders = paidOrders.length
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      logo_url: restaurant.logo_url ?? null,
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
