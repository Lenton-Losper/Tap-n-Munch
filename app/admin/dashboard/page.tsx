'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getAccessToken } from '@/lib/onboarding/api-client'
import { EmptyState, KpiCard } from '@/components/platform/ops-shell'
import type { DashboardPayload } from '@/lib/platform/dashboard'

function money(n: number) {
  return `N$${n.toLocaleString('en-NA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getAccessToken()
        const res = await fetch('/api/platform/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const payload = (await res.json()) as DashboardPayload
        if (!cancelled) setData(payload)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return <div className="text-sm text-[#8A867C]">Loading platform health…</div>
  }
  if (error || !data) {
    return <EmptyState title="Dashboard unavailable" body={error || 'No data'} />
  }

  const { kpis, series24h, attention, activity } = data
  const chartData = series24h.map((p) => ({
    ...p,
    label: p.hour.slice(11, 16),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Dashboard</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Platform health, attention queue, and recent operational activity.
        </p>
      </div>

      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Needs attention</h2>
          <Link href="/admin/alerts" className="text-xs font-medium text-[#C0392B] hover:underline">
            View all alerts →
          </Link>
        </div>
        {attention.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[#8A867C]">No critical issues right now.</div>
        ) : (
          <ul className="divide-y divide-[#EFEDE8]">
            {attention.slice(0, 8).map((a) => (
              <li key={a.key} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        a.severity === 'critical'
                          ? 'text-[11px] font-semibold uppercase text-red-700'
                          : 'text-[11px] font-semibold uppercase text-amber-700'
                      }
                    >
                      {a.severity}
                    </span>
                    <span className="text-sm font-medium text-[#1A1A1A]">{a.title}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[#8A867C]">
                    {a.restaurantName ? `${a.restaurantName} · ` : ''}
                    {a.detail}
                  </p>
                </div>
                {a.href ? (
                  <Link href={a.href} className="shrink-0 text-xs font-medium text-[#1A1A1A] underline">
                    Open
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Revenue today" value={money(kpis.revenueToday)} />
        <KpiCard label="Orders today" value={String(kpis.ordersToday)} />
        <KpiCard
          label="Pay success %"
          value={kpis.paymentSuccessRate == null ? '—' : `${kpis.paymentSuccessRate}%`}
          hint={`${kpis.failedPaymentsToday} failed today`}
        />
        <KpiCard
          label="Online terminals"
          value={`${kpis.onlineTerminals}/${kpis.totalActiveTerminals}`}
        />
        <KpiCard label="Active restaurants" value={String(kpis.activeRestaurants)} />
        <KpiCard
          label="Open bugs"
          value={String(kpis.openBugReports)}
          hint={`Receipt fails (1h): ${kpis.failedWebhooksProxy}`}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-[#E8E6E1] bg-white p-4">
          <h2 className="mb-4 text-sm font-semibold text-[#1A1A1A]">Orders & revenue (24h UTC)</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid stroke="#EFEDE8" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="orders"
                  name="Orders"
                  stroke="#1A1A1A"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
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
          <h2 className="mb-4 text-sm font-semibold text-[#1A1A1A]">Order volume by hour</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid stroke="#EFEDE8" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <YAxis tick={{ fontSize: 10, fill: '#8A867C' }} />
                <Tooltip />
                <Bar dataKey="orders" name="Orders" fill="#1A1A1A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="border-b border-[#E8E6E1] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Activity</h2>
        </div>
        {activity.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[#8A867C]">No recent activity.</div>
        ) : (
          <ul className="divide-y divide-[#EFEDE8]">
            {activity.slice(0, 20).map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#1A1A1A]">{row.label}</div>
                  {row.detail ? (
                    <div className="truncate text-xs text-[#8A867C]">{row.detail}</div>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] text-[#8A867C]">
                    {new Date(row.at).toLocaleString()}
                  </div>
                  {row.href ? (
                    <Link href={row.href} className="text-[11px] font-medium underline">
                      View
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Revenue this month" value={money(kpis.revenueMonth)} />
        <KpiCard label="Orders this month" value={String(kpis.ordersMonth)} />
        <KpiCard label="New restaurants (mo)" value={String(kpis.newRestaurantsMonth)} />
        <KpiCard label="Paid orders today" value={String(kpis.paidOrdersToday)} />
      </div>
    </div>
  )
}
