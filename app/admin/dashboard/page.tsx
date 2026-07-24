'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { getAccessToken } from '@/lib/onboarding/api-client'
import { EmptyState, HealthBadge, KpiCard, ScoreMeter } from '@/components/platform/ops-shell'
import type { DashboardPayload, HealthLevel, PlatformAlert } from '@/lib/platform/dashboard'
import { cn } from '@/lib/utils'

function money(n: number) {
  return `N$${n.toLocaleString('en-NA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function relativeTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '—'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function healthBannerClass(status: HealthLevel) {
  if (status === 'operational') return 'border-emerald-200 bg-emerald-50/80'
  if (status === 'degraded') return 'border-amber-200 bg-amber-50/80'
  if (status === 'outage') return 'border-red-200 bg-red-50/80'
  return 'border-[#E8E6E1] bg-white'
}

function SeverityPill({ severity }: { severity: PlatformAlert['severity'] }) {
  return (
    <span
      className={cn(
        'text-[10px] font-semibold uppercase tracking-wide',
        severity === 'critical' && 'text-red-700',
        severity === 'warning' && 'text-amber-700',
        severity === 'info' && 'text-sky-700',
      )}
    >
      {severity}
    </span>
  )
}

function AlertRow({ alert }: { alert: PlatformAlert }) {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <SeverityPill severity={alert.severity} />
          <span className="text-sm font-medium text-[#1A1A1A]">{alert.title}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-[#8A867C]">
          {alert.restaurantName ? `${alert.restaurantName} · ` : ''}
          {alert.detail}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-[#8A867C]">{relativeTime(alert.createdAt)}</div>
        {alert.href ? (
          <Link href={alert.href} className="text-xs font-medium text-[#1A1A1A] underline">
            Open
          </Link>
        ) : null}
      </div>
    </li>
  )
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true)
      else setRefreshing(true)
      const token = await getAccessToken()
      const res = await fetch('/api/platform/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const payload = (await res.json()) as DashboardPayload
      setData(payload)
      setLastUpdated(payload.meta.generatedAt)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!data?.meta.pollIntervalMs) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      void load({ silent: true })
    }, data.meta.pollIntervalMs)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [data?.meta.pollIntervalMs, load])

  if (loading && !data) {
    return <div className="text-sm text-[#8A867C]">Loading platform health…</div>
  }
  if ((error && !data) || !data) {
    return <EmptyState title="Dashboard unavailable" body={error || 'No data'} />
  }

  const {
    platformHealth,
    systemStatus,
    needsAttention,
    customersAffected,
    goNext,
    restaurantHealth,
    incidentTimeline,
    recentChanges,
    kpis,
    series24h,
  } = data

  const chartData = series24h.map((p) => ({
    ...p,
    label: p.hour.slice(11, 16),
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Operations</h1>
          <p className="mt-1 text-sm text-[#8A867C]">
            Platform health, customer impact, and what needs action now.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[#8A867C]">
          {refreshing ? <span>Refreshing…</span> : null}
          {lastUpdated ? <span>Updated {relativeTime(lastUpdated)}</span> : null}
          <span className="rounded border border-[#E8E6E1] bg-white px-2 py-1">
            Poll {Math.round(data.meta.pollIntervalMs / 1000)}s
          </span>
          <button
            type="button"
            onClick={() => void load({ silent: true })}
            className="rounded border border-[#E8E6E1] bg-white px-2 py-1 font-medium text-[#1A1A1A] hover:bg-[#EFEDE8]"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* 1. Is the platform healthy? */}
      <section className={cn('rounded-xl border px-5 py-4', healthBannerClass(platformHealth.status))}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8A867C]">
                Platform health
              </span>
              <HealthBadge status={platformHealth.status} />
            </div>
            <p className="mt-2 text-lg font-semibold tracking-tight text-[#1A1A1A]">
              {platformHealth.summary}
            </p>
            <p className="mt-1 text-sm text-[#5C574E]">
              {platformHealth.criticalCount} critical · {platformHealth.warningCount} warning
              {platformHealth.customersAffected ? ' · customers currently affected' : ' · no customer impact'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-right sm:grid-cols-4">
            <div>
              <div className="text-[10px] font-semibold uppercase text-[#8A867C]">Terminals</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">
                {kpis.onlineTerminals}/{kpis.totalActiveTerminals}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase text-[#8A867C]">Pay success</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">
                {kpis.paymentSuccessRate == null ? '—' : `${kpis.paymentSuccessRate}%`}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase text-[#8A867C]">Fails today</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{kpis.failedPaymentsToday}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase text-[#8A867C]">Open bugs</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{kpis.openBugReports}</div>
            </div>
          </div>
        </div>
      </section>

      {/* System status cards */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">System status</h2>
          <span className="text-[11px] text-[#8A867C]">Live probes · Cloudflare-style components</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {systemStatus.map((comp) => (
            <div key={comp.id} className="rounded-xl border border-[#E8E6E1] bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8A867C]">
                  {comp.label}
                </div>
                <HealthBadge status={comp.status} />
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-[#1A1A1A]">{comp.detail}</p>
              {comp.href ? (
                <Link href={comp.href} className="mt-2 inline-block text-[11px] font-medium underline">
                  Investigate
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 2. Are customers currently affected? */}
        <section className="rounded-xl border border-[#E8E6E1] bg-white xl:col-span-1">
          <div className="border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Customers affected</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">Active customer-facing impact only</p>
          </div>
          {customersAffected.length === 0 ? (
            <div className="px-4 py-8 text-sm text-[#8A867C]">No customer-facing incidents.</div>
          ) : (
            <ul className="divide-y divide-[#EFEDE8]">
              {customersAffected.map((a) => (
                <AlertRow key={a.key} alert={a} />
              ))}
            </ul>
          )}
        </section>

        {/* 3. What requires immediate action? */}
        <section className="rounded-xl border border-[#E8E6E1] bg-white xl:col-span-1">
          <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[#1A1A1A]">Needs attention</h2>
              <p className="mt-0.5 text-xs text-[#8A867C]">Action queue · not analytics</p>
            </div>
            <Link href="/admin/alerts" className="text-xs font-medium text-[#C0392B] hover:underline">
              Alerts →
            </Link>
          </div>
          {needsAttention.length === 0 ? (
            <div className="px-4 py-8 text-sm text-[#8A867C]">Nothing requires action right now.</div>
          ) : (
            <ul className="divide-y divide-[#EFEDE8]">
              {needsAttention.map((a) => (
                <AlertRow key={a.key} alert={a} />
              ))}
            </ul>
          )}
        </section>

        {/* 5. Where should an administrator go next? */}
        <section className="rounded-xl border border-[#E8E6E1] bg-white xl:col-span-1">
          <div className="border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Go next</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">Suggested destinations for this shift</p>
          </div>
          <ul className="divide-y divide-[#EFEDE8]">
            {goNext.map((item) => (
              <li key={item.href + item.label}>
                <Link
                  href={item.href}
                  className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-[#FAFAF8]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#1A1A1A]">{item.label}</div>
                    <div className="mt-0.5 text-xs text-[#8A867C]">{item.reason}</div>
                  </div>
                  <span className="shrink-0 text-xs text-[#C0392B]">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Restaurant health scores */}
      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Restaurant health scores</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">
              0–100 from terminals, payments, and receipt failures — worst first
            </p>
          </div>
          <Link href="/admin/restaurants" className="text-xs font-medium text-[#C0392B] hover:underline">
            Fleet →
          </Link>
        </div>
        {restaurantHealth.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[#8A867C]">No active restaurants.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-[#EFEDE8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-2 font-semibold">Restaurant</th>
                  <th className="px-4 py-2 font-semibold">Score</th>
                  <th className="px-4 py-2 font-semibold">Band</th>
                  <th className="px-4 py-2 font-semibold">Terminals</th>
                  <th className="px-4 py-2 font-semibold">Factors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {restaurantHealth.map((r) => (
                  <tr key={r.restaurantId} className="hover:bg-[#FAFAF8]">
                    <td className="px-4 py-3">
                      <Link href={r.href} className="font-medium text-[#1A1A1A] hover:underline">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <ScoreMeter score={r.score} band={r.band} />
                    </td>
                    <td className="px-4 py-3">
                      <HealthBadge status={r.band} />
                    </td>
                    <td className="px-4 py-3 tabular-nums text-[#5C574E]">
                      {r.terminalsOnline}/{r.terminalsTotal}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-xs text-[#8A867C]">
                      {r.factors.join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. What has changed recently? — Incident timeline ≠ Audit logs */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-[#E8E6E1] bg-white">
          <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[#1A1A1A]">Incident timeline</h2>
              <p className="mt-0.5 text-xs text-[#8A867C]">Operational incidents & customer impact</p>
            </div>
            <Link href="/admin/alerts" className="text-xs font-medium underline">
              Alerts
            </Link>
          </div>
          {incidentTimeline.length === 0 ? (
            <div className="px-4 py-8 text-sm text-[#8A867C]">No open incidents.</div>
          ) : (
            <ul className="divide-y divide-[#EFEDE8]">
              {incidentTimeline.map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <SeverityPill severity={row.severity} />
                      <span className="text-sm font-medium text-[#1A1A1A]">{row.label}</span>
                    </div>
                    {row.detail ? (
                      <div className="truncate text-xs text-[#8A867C]">{row.detail}</div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] text-[#8A867C]">{relativeTime(row.at)}</div>
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

        <section className="rounded-xl border border-[#E8E6E1] bg-white">
          <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[#1A1A1A]">Recent changes</h2>
              <p className="mt-0.5 text-xs text-[#8A867C]">Audit trail — who changed what</p>
            </div>
            <Link href="/admin/audit-logs" className="text-xs font-medium underline">
              Audit explorer
            </Link>
          </div>
          {recentChanges.length === 0 ? (
            <div className="px-4 py-8 text-sm text-[#8A867C]">No recent privileged changes.</div>
          ) : (
            <ul className="divide-y divide-[#EFEDE8]">
              {recentChanges.map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#1A1A1A]">{row.label}</div>
                    {row.detail ? (
                      <div className="truncate text-xs text-[#8A867C]">{row.detail}</div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[11px] text-[#8A867C]">{relativeTime(row.at)}</div>
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
      </div>

      {/* Secondary volume strip — analytics lives elsewhere */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Volume snapshot</h2>
          <Link href="/admin/analytics" className="text-xs font-medium text-[#C0392B] hover:underline">
            Full analytics →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
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
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-[#E8E6E1] bg-white p-4">
          <h2 className="mb-4 text-sm font-semibold text-[#1A1A1A]">Orders & revenue (24h UTC)</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid stroke="#EFEDE8" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#8A867C' }} />
                <Tooltip />
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
          <div className="h-56">
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
    </div>
  )
}
