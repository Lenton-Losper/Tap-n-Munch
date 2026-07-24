'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { EmptyState, HealthBadge, KpiCard } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type PaymentEvent = {
  id: string
  event_type?: string
  amount?: number
  currency?: string
  business_order_no?: string | null
  transaction_id?: string | null
  gateway_result_code?: string | null
  gateway_result_message?: string | null
  created_at: string
  app_version?: string | null
}

type TerminalPayload = {
  meta: { generatedAt: string; pollIntervalMs: number }
  terminal: {
    id: string
    restaurant_id: string
    restaurant_name?: string | null
    terminal_name?: string | null
    name?: string | null
    sn?: string | null
    online: boolean
    restaurants?: { name?: string } | Array<{ name?: string }> | null
  }
  telemetry: {
    connectivity: {
      online: boolean
      lastSeenAt: string | null
      ageMs: number | null
      heartbeatWindowMs: number
      freshness: 'fresh' | 'stale' | 'never'
    }
    identity: {
      deviceId: string | null
      sn: string | null
      deviceSerial: string | null
      model: string | null
      appVersion: string | null
      terminalName: string | null
    }
    session: {
      status: string
      active: boolean
      activatedAt: string | null
      createdAt: string | null
      refreshTokenExpiresAt: string | null
      expiresAt: string | null
      activationCodeExpiresAt: string | null
    }
    payments24h: {
      eventCount: number
      failedCount: number
      lastEventAt: string | null
      events: PaymentEvent[]
    }
    printer: {
      configured: boolean
      connectionType: string | null
      printerName: string | null
      purpose: string | null
      isDefault: boolean
      lastConnectedAt: string | null
      updatedAt: string | null
    }
    receipts24h: {
      issuanceFailures: number
      recent: Array<{ id: string; created_at: string; metadata?: unknown }>
    }
  }
  note?: string
}

function fmt(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function ageLabel(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function money(amount: number | undefined, currency?: string | null) {
  if (amount == null) return '—'
  const cur = currency || 'NAD'
  try {
    return new Intl.NumberFormat('en-NA', { style: 'currency', currency: cur === 'N$' ? 'NAD' : cur }).format(
      Number(amount),
    )
  } catch {
    return `${cur} ${Number(amount).toFixed(2)}`
  }
}

export default function TerminalDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [payload, setPayload] = useState<TerminalPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!id) return
      try {
        if (!opts?.silent) setLoading(true)
        else setRefreshing(true)
        setError('')
        const token = await getAccessToken()
        if (!token) throw new Error('Not signed in')
        const response = await fetch(`/api/platform/terminals/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || 'Failed to load terminal')
        setPayload(body as TerminalPayload)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Failed to load terminal')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [id],
  )

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  useEffect(() => {
    if (!payload?.meta.pollIntervalMs) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      void load({ silent: true })
    }, payload.meta.pollIntervalMs)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [payload?.meta.pollIntervalMs, load])

  if (loading && !payload) return <p className="text-sm text-[#8A867C]">Loading terminal diagnostics…</p>
  if (error || !payload) {
    return <EmptyState title="Terminal unavailable" body={error || 'Terminal not found.'} />
  }

  const { terminal, telemetry } = payload
  const restaurantRelation = Array.isArray(terminal.restaurants)
    ? terminal.restaurants[0]
    : terminal.restaurants
  const restaurantName = terminal.restaurant_name || restaurantRelation?.name || 'Restaurant'
  const conn = telemetry.connectivity

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/terminals" className="text-sm font-medium text-[#C0392B] hover:underline">
            ← Terminal fleet
          </Link>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
              {telemetry.identity.terminalName || terminal.sn || 'Terminal'}
            </h1>
            <HealthBadge status={conn.online ? 'online' : 'offline'} />
            <HealthBadge
              status={
                conn.freshness === 'fresh' ? 'operational' : conn.freshness === 'stale' ? 'degraded' : 'unknown'
              }
            />
          </div>
          <p className="mt-1 text-sm text-[#8A867C]">
            {restaurantName}
            {refreshing ? ' · refreshing…' : ''}
            {payload.meta.generatedAt
              ? ` · updated ${new Date(payload.meta.generatedAt).toLocaleTimeString()}`
              : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load({ silent: true })}
          className="rounded border border-[#E8E6E1] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[#EFEDE8]"
        >
          Refresh
        </button>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Connectivity"
          value={conn.online ? 'Online' : 'Offline'}
          hint={`Last heartbeat ${ageLabel(conn.ageMs)} ago · window ${Math.round(conn.heartbeatWindowMs / 60000)}m`}
        />
        <KpiCard
          label="Payments (24h)"
          value={String(telemetry.payments24h.eventCount)}
          hint={`${telemetry.payments24h.failedCount} failed / errored`}
        />
        <KpiCard
          label="Receipt fails (24h)"
          value={String(telemetry.receipts24h.issuanceFailures)}
          hint="Restaurant-scoped issuance failures"
        />
        <KpiCard
          label="Printer"
          value={
            telemetry.printer.configured
              ? telemetry.printer.connectionType || 'Configured'
              : 'Not set'
          }
          hint={
            telemetry.printer.configured
              ? [telemetry.printer.printerName, telemetry.printer.purpose].filter(Boolean).join(' · ') ||
                'Config present'
              : 'No printer config'
          }
        />
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-[#E8E6E1] bg-white">
          <div className="border-b border-[#E8E6E1] px-5 py-4">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Connectivity & session</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">Heartbeat-derived operational state</p>
          </div>
          <dl className="grid gap-px bg-[#E8E6E1] sm:grid-cols-2">
            {[
              ['Last seen', fmt(conn.lastSeenAt)],
              ['Freshness', conn.freshness],
              ['Status', telemetry.session.status],
              ['Active', telemetry.session.active ? 'Yes' : 'No'],
              ['Activated', fmt(telemetry.session.activatedAt)],
              ['Created', fmt(telemetry.session.createdAt)],
              ['Refresh token expires', fmt(telemetry.session.refreshTokenExpiresAt)],
              ['Terminal expires', fmt(telemetry.session.expiresAt)],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-5 py-4">
                <dt className="text-xs font-medium text-[#8A867C]">{label}</dt>
                <dd className="mt-1 break-all text-sm font-medium text-[#1A1A1A]">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-xl border border-[#E8E6E1] bg-white">
          <div className="border-b border-[#E8E6E1] px-5 py-4">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Device identity</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">Hardware and app build reported by the terminal</p>
          </div>
          <dl className="grid gap-px bg-[#E8E6E1] sm:grid-cols-2">
            {[
              ['Device ID', telemetry.identity.deviceId],
              ['Serial (SN)', telemetry.identity.sn],
              ['Device serial', telemetry.identity.deviceSerial],
              ['Model', telemetry.identity.model],
              ['App version', telemetry.identity.appVersion],
              ['Terminal ID', terminal.id],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-5 py-4">
                <dt className="text-xs font-medium text-[#8A867C]">{label}</dt>
                <dd className="mt-1 break-all text-sm font-medium text-[#1A1A1A]">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="flex items-center justify-between border-b border-[#E8E6E1] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Payment telemetry (24h)</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">
              Events attributed to this terminal · last event {fmt(telemetry.payments24h.lastEventAt)}
            </p>
          </div>
          <Link href="/admin/payments" className="text-xs font-medium text-[#C0392B] hover:underline">
            Payments hub →
          </Link>
        </div>
        {telemetry.payments24h.events.length === 0 ? (
          <div className="px-5 py-8 text-sm text-[#8A867C]">No payment events for this terminal in the last 24h.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-[#EFEDE8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Type</th>
                  <th className="px-4 py-2 font-semibold">Amount</th>
                  <th className="px-4 py-2 font-semibold">Business order</th>
                  <th className="px-4 py-2 font-semibold">Gateway</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {telemetry.payments24h.events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-[#FAFAF8]">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[#5C574E]">
                      {new Date(ev.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 font-medium">{ev.event_type || '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums">{money(ev.amount, ev.currency)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{ev.business_order_no || '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-[#8A867C]">
                      {[ev.gateway_result_code, ev.gateway_result_message].filter(Boolean).join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {terminal.restaurant_id ? (
        <Link
          href={`/admin/restaurants/${String(terminal.restaurant_id)}?tab=terminals`}
          className="inline-flex text-sm font-medium text-[#C0392B] hover:underline"
        >
          View restaurant →
        </Link>
      ) : null}

      <section className="rounded-xl border border-[#E8E6E1] bg-white p-5">
        <h2 className="text-sm font-semibold text-[#1A1A1A]">Remote actions</h2>
        <p className="mt-1 text-sm text-[#8A867C]">
          {payload.note ||
            'Remote device commands are coming soon. These controls are intentionally disabled.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {['Restart', 'Push APK', 'Sync'].map((action) => (
            <Button key={action} type="button" variant="outline" disabled>
              {action}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs font-medium text-[#8A867C]">Coming soon</p>
      </section>
    </div>
  )
}
