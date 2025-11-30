"use client"

import { useState } from "react"
import { ArrowLeft, Calendar, TrendingUp, TrendingDown } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"

const revenueData = [
  { day: "Mon", revenue: 1200 },
  { day: "Tue", revenue: 1890 },
  { day: "Wed", revenue: 1650 },
  { day: "Thu", revenue: 2100 },
  { day: "Fri", revenue: 2450 },
  { day: "Sat", revenue: 2890 },
  { day: "Sun", revenue: 1870 },
]

const topItems = [
  { rank: 1, name: "Grilled Chicken", orders: 87, revenue: 12615 },
  { rank: 2, name: "Beef Burger", orders: 72, revenue: 11880 },
  { rank: 3, name: "Caesar Salad", orders: 45, revenue: 4275 },
  { rank: 4, name: "Mango Smoothie", orders: 34, revenue: 2380 },
  { rank: 5, name: "Chocolate Lava Cake", orders: 28, revenue: 2240 },
]

const peakHours = [
  { period: "Lunch Rush", time: "12:00 PM - 2:00 PM", orders: 45, type: "peak" },
  { period: "Dinner Peak", time: "6:30 PM - 8:30 PM", orders: 62, type: "peak" },
  { period: "Slow Period", time: "3:00 PM - 5:00 PM", orders: 8, type: "slow" },
]

interface StatCardProps {
  value: string
  label: string
  change: number
  prefix?: string
}

function StatCard({ value, label, change, prefix = "" }: StatCardProps) {
  const isPositive = change > 0
  const isNegative = change < 0

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="text-3xl font-bold text-gray-900">
        {prefix}
        {value}
      </div>
      <div className="text-sm text-gray-600 mt-1">{label}</div>
      <div
        className={`text-sm mt-2 flex items-center gap-1 ${
          isPositive ? "text-green-600" : isNegative ? "text-red-600" : "text-gray-500"
        }`}
      >
        {isPositive && <TrendingUp className="w-4 h-4" />}
        {isNegative && <TrendingDown className="w-4 h-4" />}
        {isPositive && "+"}
        {change}%
      </div>
    </div>
  )
}

export function AnalyticsDashboard() {
  const [dateRange, setDateRange] = useState("last-7-days")

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.history.back()}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5 text-gray-700" />
              </button>
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
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stat Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          <StatCard value="12,450" label="Total Sales" change={12} prefix="N$" />
          <StatCard value="247" label="Total Orders" change={8} />
          <StatCard value="50.40" label="Average Order" change={-3} prefix="N$" />
          <StatCard value="156" label="New Customers" change={15} />
          <StatCard value="18" label="Returning Customers" change={22} />
          <StatCard value="8.2 min" label="Average Time" change={-5} />
        </div>

        {/* Revenue Trends */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Revenue Trends</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={revenueData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" stroke="#9ca3af" />
              <YAxis stroke="#9ca3af" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "white",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                }}
                formatter={(value: number) => [`N$${value}`, "Revenue"]}
              />
              <Line
                type="monotone"
                dataKey="revenue"
                stroke="#FF6B35"
                strokeWidth={3}
                dot={{ fill: "#FF6B35", r: 5 }}
                activeDot={{ r: 7 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Top Selling Items */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Top Selling Items</h2>
          <div className="space-y-3">
            {topItems.map((item) => (
              <div
                key={item.rank}
                className="flex items-center justify-between p-3 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <div className="flex items-center gap-4 flex-1">
                  <span className="font-bold text-gray-900 w-6">{item.rank}.</span>
                  <span className="text-gray-900 font-medium">{item.name}</span>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <span className="text-gray-600">{item.orders} orders</span>
                  <span className="font-bold text-[#FF6B35] w-24 text-right">N${item.revenue.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Peak Hours */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Peak Hours</h2>
          <div className="space-y-3">
            {peakHours.map((slot, index) => (
              <div key={index} className={`p-4 rounded-lg ${slot.type === "peak" ? "bg-orange-50" : "bg-gray-50"}`}>
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🍽️</span>
                  <div className="flex-1">
                    <div className="font-bold text-gray-900">
                      {slot.period}: {slot.time}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">{slot.orders} orders</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
