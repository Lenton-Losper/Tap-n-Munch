'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { RoleGuard } from '@/components/auth/role-guard'
import { supabase } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

type PeriodKey = 'week' | 'month' | 'threeMonths'

type OrderItemLike = {
  name?: string
  display_name?: string
  quantity?: number
  subtotal?: number
  base_price?: number
  menu_category_name?: string
  category_name?: string
  category?: string
}

type OrderLike = {
  id: string
  payment_status?: string
  payment_method?: string
  total?: number
  table_number?: number
  items?: OrderItemLike[]
  created_at?: unknown
  placed_at?: unknown
}

const PERIODS: Array<{ key: PeriodKey; label: string; itemTitle: string }> = [
  { key: 'week', label: 'This Week', itemTitle: 'Item of the Week' },
  { key: 'month', label: 'This Month', itemTitle: 'Item of the Month' },
  { key: 'threeMonths', label: 'Last 3 Months', itemTitle: 'Item of 3 Months' },
]

const ORANGE = '#FF6B35'
const PIE_COLORS = ['#FF6B35', '#37352F', '#C4BBAF']

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof (value as { toDate?: unknown })?.toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate()
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function currency(value: number, symbol: string) {
  return `${symbol}${value.toFixed(2)}`
}

function getPeriodRange(period: PeriodKey) {
  const now = new Date()
  const end = new Date(now)
  let start = new Date(now)

  if (period === 'week') {
    const day = (now.getDay() + 6) % 7
    start = new Date(now)
    start.setDate(now.getDate() - day)
    start.setHours(0, 0, 0, 0)
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  } else {
    start = new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0)
  }

  return { start, end }
}

function AnalyticsSkeletonCard() {
  return <div className="h-28 animate-pulse rounded-2xl border border-[#E9E9E7] bg-white" />
}

function AnalyticsContent() {
  const { restaurantId, restaurant } = useAuth()
  const router = useRouter()
  const [period, setPeriod] = useState<PeriodKey>('week')
  const [orders, setOrders] = useState<OrderLike[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    const loadPaidOrders = async () => {
      if (!restaurantId) {
        setOrders([])
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError(null)
        const { data } = await supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', restaurantId)
          .eq('payment_status', 'paid')
        const rows = (data || []).map((row: any) => ({ id: String(row.id), ...(row as Omit<OrderLike, 'id'>) }))
        setOrders(rows)
        setLastUpdated(new Date())
      } catch (err: any) {
        console.error('Failed to load analytics orders:', err)
        setError(err?.message || 'Failed to load analytics')
      } finally {
        setLoading(false)
      }
    }

    loadPaidOrders()
  }, [restaurantId, refreshTick])

  const analytics = useMemo(() => {
    const { start, end } = getPeriodRange(period)
    const periodTitle = PERIODS.find((p) => p.key === period)?.itemTitle || 'Top Item'
    const filtered = orders.filter((order) => {
      const orderDate = toDate(order.created_at) || toDate(order.placed_at)
      if (!orderDate) return false
      return orderDate >= start && orderDate <= end
    })

    const totalOrders = filtered.length
    const totalRevenue = filtered.reduce((sum, order) => sum + (Number(order.total) || 0), 0)
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

    const tableCounts = new Map<number, number>()
    filtered.forEach((order) => {
      const table = Number(order.table_number)
      if (!Number.isFinite(table) || table <= 0) return
      tableCounts.set(table, (tableCounts.get(table) || 0) + 1)
    })
    let mostActiveTable = 'N/A'
    let mostActiveCount = 0
    for (const [table, count] of tableCounts.entries()) {
      if (count > mostActiveCount) {
        mostActiveCount = count
        mostActiveTable = `Table ${table}`
      }
    }

    const itemMap = new Map<string, { name: string; quantity: number; revenue: number }>()
    const categoryMap = new Map<string, { name: string; orders: number; revenue: number }>()
    const hourMap = new Map<number, number>()
    const paymentCounts = { card: 0, cash: 0, other: 0 }

    filtered.forEach((order) => {
      const method = String(order.payment_method || '').toLowerCase()
      if (method === 'card') paymentCounts.card += 1
      else if (method === 'cash') paymentCounts.cash += 1
      else paymentCounts.other += 1

      const orderDate = toDate(order.created_at) || toDate(order.placed_at)
      if (orderDate) {
        const hour = orderDate.getHours()
        hourMap.set(hour, (hourMap.get(hour) || 0) + 1)
      }

      const items = Array.isArray(order.items) ? order.items : []
      const seenCategories = new Set<string>()

      items.forEach((item) => {
        const name = String(item.display_name || item.name || 'Unknown Item')
        const quantity = Number(item.quantity) || 1
        const revenue = Number(item.subtotal) || (Number(item.base_price) || 0) * quantity
        const existing = itemMap.get(name) || { name, quantity: 0, revenue: 0 }
        existing.quantity += quantity
        existing.revenue += revenue
        itemMap.set(name, existing)

        const category = String(item.menu_category_name || item.category_name || item.category || 'Uncategorized')
        const categoryStats = categoryMap.get(category) || { name: category, orders: 0, revenue: 0 }
        categoryStats.revenue += revenue
        if (!seenCategories.has(category)) {
          categoryStats.orders += 1
          seenCategories.add(category)
        }
        categoryMap.set(category, categoryStats)
      })
    })

    const topItems = Array.from(itemMap.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 10)
    const topItem = topItems[0] || null
    const categories = Array.from(categoryMap.values()).sort((a, b) => b.revenue - a.revenue)
    const peakHours = Array.from(hourMap.entries())
      .map(([hour, orders]) => ({ hour, orders, label: `${hour.toString().padStart(2, '0')}:00` }))
      .sort((a, b) => b.orders - a.orders)

    const paymentTotal = paymentCounts.card + paymentCounts.cash + paymentCounts.other
    const paymentSplit = [
      { name: 'Card', value: paymentCounts.card, percent: paymentTotal ? (paymentCounts.card / paymentTotal) * 100 : 0 },
      { name: 'Cash', value: paymentCounts.cash, percent: paymentTotal ? (paymentCounts.cash / paymentTotal) * 100 : 0 },
    ]

    let salesOverTime: Array<{ label: string; revenue: number }> = []
    if (period === 'week') {
      salesOverTime = Array.from({ length: 7 }).map((_, i) => {
        const day = new Date(start)
        day.setDate(start.getDate() + i)
        const label = day.toLocaleDateString('en-US', { weekday: 'short' })
        const revenue = filtered
          .filter((o) => {
            const d = toDate(o.created_at) || toDate(o.placed_at)
            return d ? d.toDateString() === day.toDateString() : false
          })
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0)
        return { label, revenue }
      })
    } else if (period === 'month') {
      const startMonth = new Date(start)
      const endMonth = new Date(end)
      const weeks: Array<{ start: Date; end: Date; label: string }> = []
      let cursor = new Date(startMonth)
      let idx = 1
      while (cursor <= endMonth) {
        const weekStart = new Date(cursor)
        const weekEnd = new Date(cursor)
        weekEnd.setDate(weekEnd.getDate() + 6)
        if (weekEnd > endMonth) weekEnd.setTime(endMonth.getTime())
        weeks.push({ start: weekStart, end: weekEnd, label: `Week ${idx}` })
        idx += 1
        cursor.setDate(cursor.getDate() + 7)
      }
      salesOverTime = weeks.map((week) => ({
        label: week.label,
        revenue: filtered
          .filter((o) => {
            const d = toDate(o.created_at) || toDate(o.placed_at)
            return d ? d >= week.start && d <= week.end : false
          })
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0),
      }))
    } else {
      salesOverTime = Array.from({ length: 3 }).map((_, i) => {
        const monthDate = new Date(start.getFullYear(), start.getMonth() + i, 1)
        const label = monthDate.toLocaleDateString('en-US', { month: 'short' })
        const monthIndex = monthDate.getMonth()
        const year = monthDate.getFullYear()
        const revenue = filtered
          .filter((o) => {
            const d = toDate(o.created_at) || toDate(o.placed_at)
            return d ? d.getMonth() === monthIndex && d.getFullYear() === year : false
          })
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0)
        return { label, revenue }
      })
    }

    return {
      totalOrders,
      totalRevenue,
      avgOrderValue,
      mostActiveTable,
      mostActiveCount,
      topItems,
      topItem,
      categories,
      peakHours,
      paymentSplit,
      salesOverTime,
      periodTitle,
      filteredCount: filtered.length,
    }
  }, [orders, period])

  const currencySymbol = restaurant?.currency || 'N$'

  return (
    <div className="min-h-screen bg-[#F7F6F3] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col justify-between gap-4 rounded-2xl border border-[#E9E9E7] bg-white p-5 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/dashboard')}
              className="h-11 w-11"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Analytics</h1>
              <p className="mt-1 text-sm text-[#6B675F]">Paid order performance for your restaurant.</p>
              <p className="mt-1 text-xs text-[#8A867E]">
              Last updated: {lastUpdated ? lastUpdated.toLocaleString() : 'Not loaded yet'}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
            <button
              type="button"
              onClick={() => setRefreshTick((v) => v + 1)}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#E9E9E7] bg-white px-3 py-2 text-sm font-medium text-[#37352F] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <div className="inline-flex w-full rounded-xl bg-[#F7F6F3] p-1 sm:w-auto">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.key)}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition sm:flex-none ${
                  period === p.key ? 'bg-white text-[#37352F] shadow-sm' : 'text-[#6B675F]'
                }`}
              >
                {p.label}
              </button>
            ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <AnalyticsSkeletonCard />
              <AnalyticsSkeletonCard />
              <AnalyticsSkeletonCard />
              <AnalyticsSkeletonCard />
            </div>
            <div className="h-80 animate-pulse rounded-2xl border border-[#E9E9E7] bg-white" />
            <div className="h-80 animate-pulse rounded-2xl border border-[#E9E9E7] bg-white" />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800">{error}</div>
        ) : analytics.filteredCount === 0 ? (
          <div className="rounded-2xl border border-[#E9E9E7] bg-white p-10 text-center">
            <h2 className="font-serif text-2xl text-[#37352F]">No orders yet</h2>
            <p className="mt-2 text-[#6B675F]">No paid orders were found for the selected period.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Orders</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">{analytics.totalOrders}</p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Revenue</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(analytics.totalRevenue, currencySymbol)}
                </p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Average Order Value</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(analytics.avgOrderValue, currencySymbol)}
                </p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Most Active Table</p>
                <p className="mt-2 text-2xl font-semibold text-[#37352F]">{analytics.mostActiveTable}</p>
                {analytics.mostActiveCount > 0 && (
                  <p className="mt-1 text-xs text-[#6B675F]">{analytics.mostActiveCount} orders</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5 xl:col-span-2">
                <h3 className="font-serif text-xl text-[#37352F]">Sales Over Time</h3>
                <div className="mt-4 h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.salesOverTime}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E9E9E7" />
                      <XAxis dataKey="label" stroke="#6B675F" />
                      <YAxis stroke="#6B675F" />
                      <Tooltip formatter={(value: number) => currency(value, currencySymbol)} />
                      <Bar dataKey="revenue" fill={ORANGE} radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <h3 className="font-serif text-xl text-[#37352F]">Payment Method Split</h3>
                <div className="mt-4 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={analytics.paymentSplit} dataKey="value" nameKey="name" outerRadius={85} label>
                        {analytics.paymentSplit.map((entry, index) => (
                          <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 space-y-1 text-sm text-[#6B675F]">
                  {analytics.paymentSplit.map((split) => (
                    <p key={split.name}>
                      {split.name}: {split.percent.toFixed(1)}% ({split.value})
                    </p>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-serif text-xl text-[#37352F]">Top Items</h3>
                  {analytics.topItem && (
                    <span className="rounded-full bg-[#FFF0E9] px-3 py-1 text-xs font-semibold text-[#C74F22]">
                      {PERIODS.find((p) => p.key === period)?.itemTitle}
                    </span>
                  )}
                </div>
                {analytics.topItem && (
                  <div className="mt-3 rounded-xl border border-[#FFD8C9] bg-[#FFF7F4] p-3">
                    <p className="font-semibold text-[#37352F]">{analytics.topItem.name}</p>
                    <p className="text-sm text-[#6B675F]">
                      {analytics.topItem.quantity} sold • {currency(analytics.topItem.revenue, currencySymbol)}
                    </p>
                  </div>
                )}
                <div className="mt-4 space-y-2">
                  {analytics.topItems.map((item, index) => (
                    <div
                      key={`${item.name}-${index}`}
                      className="flex items-center justify-between rounded-lg border border-[#EFEDEA] px-3 py-2"
                    >
                      <p className="pr-3 text-sm font-medium text-[#37352F]">{item.name}</p>
                      <p className="text-right text-sm text-[#6B675F]">
                        {item.quantity} • {currency(item.revenue, currencySymbol)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <h3 className="font-serif text-xl text-[#37352F]">Category Breakdown</h3>
                <div className="mt-4 space-y-2">
                  {analytics.categories.map((cat) => (
                    <div key={cat.name} className="flex items-center justify-between rounded-lg border border-[#EFEDEA] px-3 py-2">
                      <p className="text-sm font-medium text-[#37352F]">{cat.name}</p>
                      <p className="text-sm text-[#6B675F]">
                        {cat.orders} orders / {currency(cat.revenue, currencySymbol)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
              <h3 className="font-serif text-xl text-[#37352F]">Peak Hours</h3>
              <div className="mt-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.peakHours.slice(0, 10)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E9E9E7" />
                    <XAxis dataKey="label" stroke="#6B675F" />
                    <YAxis stroke="#6B675F" />
                    <Tooltip />
                    <Bar dataKey="orders" fill="#37352F" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function AnalyticsPage() {
  return (
    <RoleGuard allowedRoles={['owner', 'manager']}>
      <AnalyticsContent />
    </RoleGuard>
  )
}
