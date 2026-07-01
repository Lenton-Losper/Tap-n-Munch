'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getAnalyticsRange, getDailyAnalytics, DailyAnalytics } from '@/lib/supabase/analytics'
import { ArrowLeft, Calendar, TrendingUp, TrendingDown } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

interface StatCardProps {
  value: string
  label: string
  change?: number
  prefix?: string
}

function StatCard({ value, label, change, prefix = '' }: StatCardProps) {
  const isPositive = change !== undefined && change > 0
  const isNegative = change !== undefined && change < 0

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="text-3xl font-bold text-gray-900">
        {prefix}
        {value}
      </div>
      <div className="text-sm text-gray-600 mt-1">{label}</div>
      {change !== undefined && (
        <div
          className={`text-sm mt-2 flex items-center gap-1 ${
            isPositive ? 'text-green-600' : isNegative ? 'text-red-600' : 'text-gray-500'
          }`}
        >
          {isPositive && <TrendingUp className="w-4 h-4" />}
          {isNegative && <TrendingDown className="w-4 h-4" />}
          {isPositive && '+'}
          {change}%
        </div>
      )}
    </div>
  )
}

export function AnalyticsDashboard() {
  const { user, restaurantId, restaurant } = useAuth()
  const router = useRouter()
  const [dateRange, setDateRange] = useState('last-7-days')
  const [analytics, setAnalytics] = useState<DailyAnalytics[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const canFetchAnalytics = Boolean(user && restaurantId)
  const showAnalyticsLoading = canFetchAnalytics && loading

  useEffect(() => {
    if (!canFetchAnalytics) return

    const loadData = async () => {
      try {
        setLoading(true)

        // Calculate date range
        const endDate = new Date()
        let startDate = new Date()
        
        switch (dateRange) {
          case 'today':
            startDate = new Date(endDate)
            startDate.setHours(0, 0, 0, 0)
            break
          case 'last-7-days':
            startDate.setDate(endDate.getDate() - 7)
            break
          case 'last-30-days':
            startDate.setDate(endDate.getDate() - 30)
            break
          case 'this-month':
            startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
            break
          default:
            startDate.setDate(endDate.getDate() - 7)
        }

        // Get analytics for date range
        const startDateStr = startDate.toISOString().split('T')[0]
        const endDateStr = endDate.toISOString().split('T')[0]
        
        const analyticsData = await getAnalyticsRange(restaurantId, startDateStr, endDateStr)
        setAnalytics(analyticsData)
        setError(null)
      } catch (err: any) {
        console.error('Failed to load analytics:', err)
        if (err?.message?.includes('index')) {
          setError(
            'Supabase index required. Please create the index using the link in the console error, ' +
            'or deploy the required indexes using Supabase.'
          )
        } else {
          setError(err?.message || 'Failed to load analytics data')
        }
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [user, restaurantId, dateRange])

  // Calculate aggregated stats
  const totalSales = analytics.reduce((sum, day) => sum + day.total_revenue, 0)
  const totalOrders = analytics.reduce((sum, day) => sum + day.total_orders, 0)
  const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0
  const avgPrepTime = analytics.length > 0
    ? analytics.reduce((sum, day) => sum + day.avg_prep_time_minutes, 0) / analytics.length
    : 0

  // Prepare chart data
  const revenueData = analytics.map(day => ({
    day: new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' }),
    date: day.date,
    revenue: day.total_revenue,
    orders: day.total_orders,
  }))

  // Get top items from latest day or aggregate
  const topItemsMap = new Map<string, { name: string; orders: number; revenue: number }>()
  analytics.forEach(day => {
    day.top_items.forEach(item => {
      const existing = topItemsMap.get(item.item_id)
      if (existing) {
        existing.orders += item.orders
        existing.revenue += item.revenue
      } else {
        topItemsMap.set(item.item_id, { ...item })
      }
    })
  })
  const topItems = Array.from(topItemsMap.values())
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5)

  // Get peak hours
  const hourCounts = new Map<number, number>()
  analytics.forEach(day => {
    day.peak_hours.forEach(hour => {
      const existing = hourCounts.get(hour.hour) || 0
      hourCounts.set(hour.hour, existing + hour.orders)
    })
  })
  const peakHours = Array.from(hourCounts.entries())
    .map(([hour, orders]) => ({ hour, orders, period: `${hour}:00` }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10)

  if (showAnalyticsLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => router.push('/dashboard')}
                >
                  <ArrowLeft className="w-5 h-5" />
                </Button>
                <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
              </div>
            </div>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h2 className="text-lg font-semibold text-red-900 mb-2">Error Loading Analytics</h2>
            <p className="text-red-800 mb-4">{error}</p>
            <p className="text-sm text-red-700">
              Check the browser console for the index creation URL, or see the firestore.indexes.json file 
              in your project root for the required indexes.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push('/dashboard')}
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
            </div>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-40">
                <Calendar className="w-4 h-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="last-7-days">Last 7 Days</SelectItem>
                <SelectItem value="last-30-days">Last 30 Days</SelectItem>
                <SelectItem value="this-month">This Month</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stat Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          <StatCard
            value={totalSales.toFixed(2)}
            label="Total Sales"
            prefix={restaurant?.currency || 'N$'}
          />
          <StatCard
            value={totalOrders.toString()}
            label="Total Orders"
          />
          <StatCard
            value={avgOrderValue.toFixed(2)}
            label="Average Order Value"
            prefix={restaurant?.currency || 'N$'}
          />
          <StatCard
            value={analytics.reduce((sum, day) => sum + day.new_customers, 0).toString()}
            label="New Customers"
          />
          <StatCard
            value={analytics.reduce((sum, day) => sum + day.returning_customers, 0).toString()}
            label="Returning Customers"
          />
          <StatCard
            value={avgPrepTime.toFixed(1)}
            label="Average Prep Time (min)"
          />
        </div>

        {/* Revenue Trends */}
        {revenueData.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-6">Revenue Trends</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number) => [`${restaurant?.currency || 'N$'}${value.toFixed(2)}`, 'Revenue']}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="#FF6B35"
                  strokeWidth={3}
                  dot={{ fill: '#FF6B35', r: 5 }}
                  activeDot={{ r: 7 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Top Selling Items */}
        {topItems.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-6">Top Selling Items</h2>
            <div className="space-y-4">
              {topItems.map((item, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-[#FF6B35] text-white flex items-center justify-center font-bold">
                      {index + 1}
                    </div>
                    <div>
                      <div className="font-semibold">{item.name}</div>
                      <div className="text-sm text-gray-600">
                        {item.orders} orders • {restaurant?.currency || 'N$'}{item.revenue.toFixed(2)} revenue
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Peak Hours */}
        {peakHours.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-6">Peak Hours</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={peakHours}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="period" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                  }}
                />
                <Bar dataKey="orders" fill="#FF6B35" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {analytics.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">No analytics data available for the selected period</p>
          </div>
        )}
      </div>
    </div>
  )
}
