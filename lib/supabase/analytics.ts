// @ts-nocheck
import { createServerSupabaseClient } from './server'
import { supabase } from './client'

export interface DailyAnalytics {
  id: string
  restaurant_id: string
  date: string
  total_orders: number
  total_revenue: number
  total_tax: number
  total_tips: number
  new_customers: number
  returning_customers: number
  avg_order_value: number
  avg_prep_time_minutes: number
  top_items: Array<{ item_id: string; name: string; orders: number; revenue: number }>
  peak_hours: Array<{ hour: number; orders: number }>
}

function ymd(date: Date) {
  return date.toISOString().split('T')[0]
}

export async function calculateDailyAnalytics(restaurantId: string, date: string): Promise<DailyAnalytics> {
  const sb = createServerSupabaseClient()
  const dayStart = new Date(`${date}T00:00:00.000Z`).toISOString()
  const dayEnd = new Date(`${date}T23:59:59.999Z`).toISOString()
  const { data: orders = [] } = await sb
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('payment_status', 'paid')
    .gte('placed_at', dayStart)
    .lte('placed_at', dayEnd)

  const totalOrders = orders.length
  const totalRevenue = orders.reduce((sum: number, o: any) => sum + (Number(o.total) || 0), 0)
  const totalTax = orders.reduce((sum: number, o: any) => sum + (Number(o.tax) || 0), 0)
  const totalTips = orders.reduce((sum: number, o: any) => sum + (Number(o.tip) || 0), 0)
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0
  const avgPrepTime = 0

  const itemCounts: Record<string, { name: string; orders: number; revenue: number }> = {}
  const hourCounts: Record<number, number> = {}
  for (const order of orders as any[]) {
    const items = Array.isArray(order.items) ? order.items : []
    for (const item of items) {
      const id = String(item.menu_item_id || item.id || item.name || 'unknown')
      if (!itemCounts[id]) itemCounts[id] = { name: String(item.name || 'Item'), orders: 0, revenue: 0 }
      itemCounts[id].orders += Number(item.quantity) || 1
      itemCounts[id].revenue += Number(item.subtotal) || 0
    }
    const h = new Date(String(order.placed_at || order.created_at || dayStart)).getUTCHours()
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }

  const topItems = Object.entries(itemCounts)
    .map(([item_id, d]) => ({ item_id, ...d }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10)
  const peakHours = Object.entries(hourCounts)
    .map(([hour, count]) => ({ hour: Number(hour), orders: count }))
    .sort((a, b) => b.orders - a.orders)

  return {
    id: `analytics_${date}_${restaurantId}`,
    restaurant_id: restaurantId,
    date,
    total_orders: totalOrders,
    total_revenue: totalRevenue,
    total_tax: totalTax,
    total_tips: totalTips,
    new_customers: 0,
    returning_customers: 0,
    avg_order_value: avgOrderValue,
    avg_prep_time_minutes: avgPrepTime,
    top_items: topItems,
    peak_hours: peakHours,
  }
}

export async function getDailyAnalytics(restaurantId: string, date: string): Promise<DailyAnalytics> {
  const dayStart = new Date(`${date}T00:00:00.000Z`).toISOString()
  const dayEnd = new Date(`${date}T23:59:59.999Z`).toISOString()
  const { data: orders = [] } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('payment_status', 'paid')
    .gte('placed_at', dayStart)
    .lte('placed_at', dayEnd)

  const totalOrders = orders.length
  const totalRevenue = orders.reduce((sum: number, o: any) => sum + (Number(o.total) || 0), 0)
  const totalTax = orders.reduce((sum: number, o: any) => sum + (Number(o.tax) || 0), 0)
  const totalTips = orders.reduce((sum: number, o: any) => sum + (Number(o.tip) || 0), 0)
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0
  const avgPrepTime = 0

  const itemCounts: Record<string, { name: string; orders: number; revenue: number }> = {}
  const hourCounts: Record<number, number> = {}
  for (const order of orders as any[]) {
    const items = Array.isArray(order.items) ? order.items : []
    for (const item of items) {
      const id = String(item.menu_item_id || item.id || item.name || 'unknown')
      if (!itemCounts[id]) itemCounts[id] = { name: String(item.name || 'Item'), orders: 0, revenue: 0 }
      itemCounts[id].orders += Number(item.quantity) || 1
      itemCounts[id].revenue += Number(item.subtotal) || 0
    }
    const h = new Date(String(order.placed_at || order.created_at || dayStart)).getUTCHours()
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }

  const topItems = Object.entries(itemCounts)
    .map(([item_id, d]) => ({ item_id, ...d }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10)
  const peakHours = Object.entries(hourCounts)
    .map(([hour, count]) => ({ hour: Number(hour), orders: count }))
    .sort((a, b) => b.orders - a.orders)

  return {
    id: `analytics_${date}_${restaurantId}`,
    restaurant_id: restaurantId,
    date,
    total_orders: totalOrders,
    total_revenue: totalRevenue,
    total_tax: totalTax,
    total_tips: totalTips,
    new_customers: 0,
    returning_customers: 0,
    avg_order_value: avgOrderValue,
    avg_prep_time_minutes: avgPrepTime,
    top_items: topItems,
    peak_hours: peakHours,
  }
}

export async function getAnalyticsRange(
  restaurantId: string,
  startDate: string,
  endDate: string
): Promise<DailyAnalytics[]> {
  const result: DailyAnalytics[] = []
  const start = new Date(startDate)
  const end = new Date(endDate)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    result.push(await getDailyAnalytics(restaurantId, ymd(d)))
  }
  return result
}
