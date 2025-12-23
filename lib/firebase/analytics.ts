import { collection, query, where, getDocs, doc, setDoc, getDoc } from 'firebase/firestore'
import { db } from './config'
import { Order } from './orders'

export interface DailyAnalytics {
  id: string
  restaurant_id: string
  date: string // YYYY-MM-DD format
  total_orders: number
  total_revenue: number
  total_tax: number
  total_tips: number
  new_customers: number
  returning_customers: number
  avg_order_value: number
  avg_prep_time_minutes: number
  top_items: Array<{
    item_id: string
    name: string
    orders: number
    revenue: number
  }>
  peak_hours: Array<{
    hour: number
    orders: number
  }>
}

// Calculate analytics from orders
export async function calculateDailyAnalytics(
  restaurantId: string,
  date: string // YYYY-MM-DD
): Promise<DailyAnalytics> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const startDate = new Date(`${date}T00:00:00Z`)
    const endDate = new Date(`${date}T23:59:59Z`)
    
    // Get all completed orders for the day
    const q = query(
      collection(db, 'orders'),
      where('restaurant_id', '==', restaurantId),
      where('status', '==', 'completed')
    )
    
    const snapshot = await getDocs(q)
    const orders: Order[] = []
    
    snapshot.forEach(doc => {
      const order = { id: doc.id, ...doc.data() } as Order
      const placedAt = new Date(order.placed_at)
      if (placedAt >= startDate && placedAt <= endDate) {
        orders.push(order)
      }
    })
    
    // Calculate stats
    const totalOrders = orders.length
    const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0)
    const totalTax = orders.reduce((sum, o) => sum + o.tax, 0)
    const totalTips = orders.reduce((sum, o) => sum + o.tip, 0)
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0
    
    // Calculate average prep time
    const ordersWithPrepTime = orders.filter(o => o.prep_time_minutes)
    const avgPrepTime = ordersWithPrepTime.length > 0
      ? ordersWithPrepTime.reduce((sum, o) => sum + (o.prep_time_minutes || 0), 0) / ordersWithPrepTime.length
      : 0
    
    // Calculate top items
    const itemCounts: Record<string, { name: string; orders: number; revenue: number }> = {}
    orders.forEach(order => {
      order.items.forEach(item => {
        if (!itemCounts[item.menu_item_id]) {
          itemCounts[item.menu_item_id] = {
            name: item.name,
            orders: 0,
            revenue: 0,
          }
        }
        itemCounts[item.menu_item_id].orders += item.quantity
        itemCounts[item.menu_item_id].revenue += item.subtotal
      })
    })
    
    const topItems = Object.entries(itemCounts)
      .map(([item_id, data]) => ({ item_id, ...data }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10)
    
    // Calculate peak hours
    const hourCounts: Record<number, number> = {}
    orders.forEach(order => {
      const hour = new Date(order.placed_at).getUTCHours()
      hourCounts[hour] = (hourCounts[hour] || 0) + 1
    })
    
    const peakHours = Object.entries(hourCounts)
      .map(([hour, orders]) => ({ hour: parseInt(hour), orders }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 24)
    
    // Customer tracking (simplified - would need customer tracking in production)
    const uniquePhones = new Set(orders.map(o => o.customer?.phone).filter(Boolean))
    const newCustomers = uniquePhones.size // Simplified
    const returningCustomers = 0 // Would need historical data
    
    return {
      id: `analytics_${date}_${restaurantId}`,
      restaurant_id: restaurantId,
      date,
      total_orders: totalOrders,
      total_revenue: totalRevenue,
      total_tax: totalTax,
      total_tips: totalTips,
      new_customers: newCustomers,
      returning_customers: returningCustomers,
      avg_order_value: avgOrderValue,
      avg_prep_time_minutes: avgPrepTime,
      top_items: topItems,
      peak_hours: peakHours,
    }
  } catch (error: any) {
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      const indexUrlMatch = error.message?.match(/https:\/\/[^\s]+/)
      const indexUrl = indexUrlMatch ? indexUrlMatch[0] : null
      console.error(
        'Firestore index required for analytics query. ' +
        'Please create the index using the link in the error message, ' +
        'or deploy firestore.indexes.json using: firebase deploy --only firestore:indexes'
      )
      if (indexUrl) {
        console.error('Index creation URL:', indexUrl)
      }
      throw new Error(
        'Firestore index required for analytics. Please create the required index. ' +
        'See the console for the index creation URL or deploy firestore.indexes.json. ' +
        (indexUrl ? `\nCreate index here: ${indexUrl}` : '')
      )
    }
    console.error('Error calculating analytics:', error)
    throw new Error(error.message || 'Failed to calculate analytics')
  }
}

// Get or create daily analytics
export async function getDailyAnalytics(
  restaurantId: string,
  date: string
): Promise<DailyAnalytics> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docId = `analytics_${date}_${restaurantId}`
    const docRef = doc(db, 'analytics_daily', docId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as DailyAnalytics
    }
    
    // Calculate and save if doesn't exist
    const analytics = await calculateDailyAnalytics(restaurantId, date)
    await setDoc(docRef, analytics)
    return analytics
  } catch (error: any) {
    throw new Error(error.message || 'Failed to get analytics')
  }
}

// Get analytics for a date range
export async function getAnalyticsRange(
  restaurantId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
): Promise<DailyAnalytics[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const analytics: DailyAnalytics[] = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0]
      const daily = await getDailyAnalytics(restaurantId, dateStr)
      analytics.push(daily)
    }
    
    return analytics
  } catch (error: any) {
    throw new Error(error.message || 'Failed to get analytics range')
  }
}

