'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { EmptyState, KpiCard } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type SeriesPoint = {
  date?: string
  day?: string
  label?: string
  revenue?: number
  orders?: number
  restaurants?: number
}

type Merchant = {
  id?: string
  restaurant_id?: string
  restaurantId?: string
  name?: string
  restaurant_name?: string
  restaurantName?: string
  revenue?: number
  orders?: number
  success_rate?: number
}

type AnalyticsPayload = {
  kpis?: Record<string, number>
  series?: SeriesPoint[]
  daily?: SeriesPoint[]
  timeseries?: SeriesPoint[]
  topMerchants?: Merchant[]
  top_merchants?: Merchant[]
  topRestaurants?: Merchant[]
  terminalUptime?: { online: number; active: number; ratio: number | null }
}

function money(value: unknown) {
  return `N$${Number(value || 0).toLocaleString('en-NA', {
    maximumFractionDigits: 0,
  })}`
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/analytics', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load analytics')
      setData(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  if (loading) return <p className="text-sm text-[#8A867C]">Loading analytics…</p>
  if (error || !data) {
    return <EmptyState title="Analytics unavailable" body={error || 'No analytics data.'} />
  }

  const kpis = data.kpis || {}
  const series = (data.series || data.daily || data.timeseries || []).map((point) => ({
    ...point,
    displayDate: point.label || point.date || point.day || '',
  }))
  const merchants = data.topRestaurants || data.topMerchants || data.top_merchants || []
  const totalRevenue =
    kpis.totalRevenue ?? kpis.revenue ?? series.reduce((sum, point) => sum + Number(point.revenue || 0), 0)
  const totalOrders =
    kpis.totalOrders ?? kpis.orders ?? series.reduce((sum, point) => sum + Number(point.orders || 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Analytics</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Platform growth, transaction volume, and merchant performance.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Revenue" value={money(totalRevenue)} />
        <KpiCard label="Orders" value={String(totalOrders)} />
        <KpiCard
          label="Average order"
          value={totalOrders ? money(Number(totalRevenue) / Number(totalOrders)) : '—'}
        />
        <KpiCard
          label="Terminal uptime"
          value={
            data.terminalUptime?.ratio == null
              ? '—'
              : `${(data.terminalUptime.ratio * 100).toFixed(1)}%`
          }
          hint={
            data.terminalUptime
              ? `${data.terminalUptime.online}/${data.terminalUptime.active} online`
              : undefined
          }
        />
      </section>

      {series.length === 0 ? (
        <EmptyState title="No trend data" body="Analytics series will appear after activity is recorded." />
      ) : (
        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-xl border border-[#E8E6E1] bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-[#1A1A1A]">Revenue</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series}>
                  <CartesianGrid stroke="#EFEDE8" vertical={false} />
                  <XAxis dataKey="displayDate" tick={{ fontSize: 10, fill: '#8A867C' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#8A867C' }} />
                  <Tooltip formatter={(value) => money(value)} />
                  <Line
                    dataKey="revenue"
                    name="Revenue"
                    stroke="#C0392B"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-[#E8E6E1] bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-[#1A1A1A]">Orders</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series}>
                  <CartesianGrid stroke="#EFEDE8" vertical={false} />
                  <XAxis dataKey="displayDate" tick={{ fontSize: 10, fill: '#8A867C' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#8A867C' }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="orders" name="Orders" fill="#1A1A1A" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
        <div className="border-b border-[#E8E6E1] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Top merchants</h2>
        </div>
        {merchants.length === 0 ? (
          <div className="p-6 text-sm text-[#8A867C]">No merchant rankings available.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3">Merchant</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Orders</th>
                  <th className="px-4 py-3 text-right">Success rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {merchants.map((merchant, index) => {
                  const id = merchant.restaurantId || merchant.restaurant_id || merchant.id
                  return (
                    <tr key={id || index}>
                      <td className="px-4 py-3 font-medium text-[#1A1A1A]">
                        {id ? (
                          <Link href={`/admin/restaurants/${id}`} className="hover:underline">
                            {merchant.restaurantName || merchant.restaurant_name || merchant.name || id}
                          </Link>
                        ) : (
                          merchant.restaurantName || merchant.restaurant_name || merchant.name || 'Unknown'
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{money(merchant.revenue)}</td>
                      <td className="px-4 py-3 text-right">{merchant.orders || 0}</td>
                      <td className="px-4 py-3 text-right text-[#5C574E]">
                        {merchant.success_rate == null ? '—' : `${merchant.success_rate}%`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
