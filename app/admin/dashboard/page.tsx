'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { getAccessToken } from '@/lib/onboarding/api-client'
import { EmptyState } from '@/components/platform/ops-shell'
import type {
  DashboardPayload,
  HealthLevel,
  OperatorStatus,
} from '@/lib/platform/dashboard'
import { cn } from '@/lib/utils'

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

type UiStatus = OperatorStatus | HealthLevel | 'watch' | 'critical'

function statusWord(label: UiStatus) {
  if (label === 'operational' || label === 'healthy') return 'Healthy'
  if (label === 'attention' || label === 'watch') return 'Attention'
  if (label === 'degraded') return 'Degraded'
  if (label === 'outage' || label === 'critical') return 'Outage'
  return 'Unknown'
}

function statusTone(label: UiStatus) {
  if (label === 'operational' || label === 'healthy') return 'text-emerald-700'
  if (label === 'attention' || label === 'watch') return 'text-amber-700'
  if (label === 'degraded') return 'text-amber-700'
  if (label === 'outage' || label === 'critical') return 'text-red-700'
  return 'text-[#6B6760]'
}

function StatusDot({ label }: { label: UiStatus }) {
  const tone =
    label === 'operational' || label === 'healthy'
      ? 'bg-emerald-500'
      : label === 'attention' || label === 'watch' || label === 'degraded'
        ? 'bg-amber-500'
        : label === 'outage' || label === 'critical'
          ? 'bg-red-500'
          : 'bg-[#C4C0B6]'
  return <span className={cn('mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden />
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-[#1A1A1A]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function DashboardSkeleton() {
  return (
    <div className="animate-pulse space-y-10">
      <div className="space-y-3">
        <div className="h-3 w-36 rounded bg-[#E8E6E1]" />
        <div className="h-8 w-48 rounded bg-[#E8E6E1]" />
        <div className="h-4 w-72 rounded bg-[#EFEDE8]" />
      </div>
      <div className="h-24 rounded-xl bg-[#EFEDE8]" />
      <div className="space-y-2">
        <div className="h-14 rounded-xl bg-[#EFEDE8]" />
        <div className="h-14 rounded-xl bg-[#EFEDE8]" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 rounded-xl bg-[#EFEDE8]" />
        ))}
      </div>
    </div>
  )
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activityTab, setActivityTab] = useState<'incidents' | 'audit' | 'deployments'>('incidents')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true)
      const token = await getAccessToken()
      const res = await fetch('/api/platform/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setData((await res.json()) as DashboardPayload)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  useEffect(() => {
    if (!data?.meta.pollIntervalMs) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => void load({ silent: true }), data.meta.pollIntervalMs)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [data?.meta.pollIntervalMs, load])

  if (loading && !data) return <DashboardSkeleton />
  if ((error && !data) || !data) {
    return <EmptyState title="Dashboard unavailable" body={error || 'No data'} />
  }

  const {
    platformStatus,
    currentIncident,
    liveIncidents,
    systemStatus,
    restaurantsNeedingAttention,
    activity,
  } = data

  const activityRows =
    activityTab === 'incidents'
      ? activity.incidents
      : activityTab === 'audit'
        ? activity.audit
        : activity.deployments

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-10">
      {/* Platform Status headline */}
      <header className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8A867C]">
          FlashTap Operations
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#1A1A1A]">Platform Status</h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold',
              platformStatus.label === 'healthy' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              platformStatus.label === 'degraded' && 'border-amber-200 bg-amber-50 text-amber-900',
              platformStatus.label === 'outage' && 'border-red-200 bg-red-50 text-red-800',
              platformStatus.label === 'unknown' && 'border-[#E8E6E1] bg-white text-[#6B6760]',
              platformStatus.label === 'attention' && 'border-amber-200 bg-amber-50 text-amber-900',
            )}
          >
            <StatusDot label={platformStatus.label} />
            {statusWord(platformStatus.label)}
          </span>
        </div>
        <p className="max-w-2xl text-[15px] text-[#5C574E]">{platformStatus.headline}</p>
        <p className="text-[12px] text-[#8A867C]">Updated {relativeTime(data.meta.generatedAt)}</p>
      </header>

      {/* Current Incident — entire focus when present; gone when not */}
      {currentIncident ? (
        <Link
          href={currentIncident.href}
          className="block rounded-xl border border-red-200/80 bg-red-50/70 px-5 py-4 shadow-[0_1px_2px_rgb(0_0_0_/0.03)] transition-colors hover:bg-red-50"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-red-700/80">
                Current Incident
              </div>
              <div className="text-[16px] font-semibold tracking-tight text-[#1A1A1A]">
                {currentIncident.title}
              </div>
              <p className="text-sm text-[#5C574E]">{currentIncident.summary}</p>
              <p className="text-[12px] text-[#8A867C]">
                Started {relativeTime(currentIncident.startedAt)} · Status:{' '}
                <span className="font-medium capitalize text-[#1A1A1A]">{currentIncident.status}</span>
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-red-700">View incident →</span>
          </div>
        </Link>
      ) : null}

      {/* Live Incidents — only when needed */}
      {liveIncidents.length > 0 ? (
        <Section title="Live Incidents">
          <ul className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
            {liveIncidents.map((incident, idx) => (
              <li
                key={incident.id}
                className={cn(idx > 0 && 'border-t border-[#EFEDE8]')}
              >
                <Link
                  href={incident.href}
                  className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[#FAFAF8]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[#1A1A1A]">{incident.title}</span>
                      <span className={cn('text-[12px] font-semibold', statusTone(incident.status))}>
                        {statusWord(incident.status)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[13px] text-[#8A867C]">{incident.summary}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#C4C0B6]" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* Platform Status probes */}
      <Section title="Platform Status">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {systemStatus.map((comp) => {
            const op = healthToUi(comp.status)
            const body = (
              <div className="rounded-xl border border-[#E8E6E1] bg-white px-4 py-4 shadow-[0_1px_2px_rgb(0_0_0_/0.03)] transition-colors hover:bg-[#FAFAF8]">
                <div className="text-[12px] font-medium text-[#8A867C]">{comp.label}</div>
                <div className="mt-3 flex items-center gap-2">
                  <StatusDot label={comp.status} />
                  <span className={cn('text-sm font-semibold', statusTone(comp.status))}>
                    {statusWord(op)}
                  </span>
                </div>
                {comp.sinceLabel && comp.status !== 'operational' ? (
                  <p className="mt-1.5 text-[12px] text-[#8A867C]">{comp.sinceLabel}</p>
                ) : (
                  <p className="mt-1.5 text-[12px] text-transparent">—</p>
                )}
              </div>
            )
            return comp.href ? (
              <Link key={comp.id} href={comp.href}>
                {body}
              </Link>
            ) : (
              <div key={comp.id}>{body}</div>
            )
          })}
        </div>
      </Section>

      {/* Restaurants needing attention — max 5, with owner */}
      {restaurantsNeedingAttention.length > 0 ? (
        <Section
          title="Restaurants needing attention"
          action={
            <Link href="/admin/restaurants" className="text-[12px] font-medium text-[#8A867C] hover:text-[#1A1A1A]">
              View all →
            </Link>
          }
        >
          <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] gap-3 border-b border-[#EFEDE8] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[#8A867C] sm:grid">
              <span>Restaurant</span>
              <span>Issue</span>
              <span>Owner</span>
              <span className="w-4" />
            </div>
            <ul>
              {restaurantsNeedingAttention.map((r, idx) => (
                <li key={r.restaurantId} className={cn(idx > 0 && 'border-t border-[#EFEDE8]')}>
                  <Link
                    href={r.href}
                    className="grid grid-cols-1 items-center gap-1 px-5 py-3.5 transition-colors hover:bg-[#FAFAF8] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:gap-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#1A1A1A]">{r.name}</div>
                      <div className={cn('mt-0.5 text-[12px] font-medium sm:hidden', statusTone(r.band === 'watch' ? 'attention' : r.band))}>
                        {r.issue}
                      </div>
                    </div>
                    <div className="hidden truncate text-[13px] text-[#5C574E] sm:block">{r.issue}</div>
                    <div className="truncate text-[13px] text-[#8A867C]">
                      {r.ownerName || r.ownerEmail || '—'}
                    </div>
                    <ChevronRight className="hidden h-4 w-4 text-[#C4C0B6] sm:block" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      {/* Activity */}
      <Section title="Activity">
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
          <div className="flex gap-1 border-b border-[#EFEDE8] px-2 pt-2">
            {(
              [
                ['incidents', 'Incidents'],
                ['audit', 'Audit'],
                ['deployments', 'Deployments'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActivityTab(key)}
                className={cn(
                  'rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
                  activityTab === key
                    ? 'bg-[#F4F4F2] text-[#1A1A1A]'
                    : 'text-[#8A867C] hover:text-[#1A1A1A]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {activityRows.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-[#8A867C]">
              {activityTab === 'deployments'
                ? 'No recent deployments recorded.'
                : activityTab === 'audit'
                  ? 'No recent audit activity.'
                  : 'No open incidents.'}
            </div>
          ) : (
            <ul>
              {activityRows.slice(0, 8).map((row, idx) => (
                <li key={row.id} className={cn(idx > 0 && 'border-t border-[#EFEDE8]')}>
                  {row.href ? (
                    <Link
                      href={row.href}
                      className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-[#FAFAF8]"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#1A1A1A]">{row.label}</div>
                        {row.detail ? (
                          <div className="mt-0.5 truncate text-[12px] text-[#8A867C]">{row.detail}</div>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[12px] text-[#8A867C]">{relativeTime(row.at)}</span>
                    </Link>
                  ) : (
                    <div className="flex items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#1A1A1A]">{row.label}</div>
                        {row.detail ? (
                          <div className="mt-0.5 truncate text-[12px] text-[#8A867C]">{row.detail}</div>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[12px] text-[#8A867C]">{relativeTime(row.at)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-[#EFEDE8] px-5 py-3">
            <Link
              href={
                activityTab === 'audit'
                  ? '/admin/audit-logs'
                  : activityTab === 'deployments'
                    ? '/admin/audit-logs'
                    : '/admin/alerts'
              }
              className="text-[12px] font-medium text-[#8A867C] hover:text-[#1A1A1A]"
            >
              View all {activityTab} →
            </Link>
          </div>
        </div>
      </Section>
    </div>
  )
}

function healthToUi(status: HealthLevel): OperatorStatus {
  if (status === 'operational') return 'healthy'
  if (status === 'degraded') return 'degraded'
  if (status === 'outage') return 'outage'
  return 'unknown'
}
