'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { EmptyState, HealthBadge } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type TerminalDetail = Record<string, unknown> & {
  id?: string
  restaurant_id?: string
  restaurant_name?: string
  restaurants?: { name?: string } | Array<{ name?: string }> | null
  terminal_name?: string
  name?: string
  sn?: string
  device_serial?: string
  app_version?: string
  last_seen_at?: string
  last_seen?: string
  active?: boolean
  status?: string
  online?: boolean
}

const DIAGNOSTICS = [
  ['Device ID', 'device_id'],
  ['Serial number', 'sn'],
  ['Device serial', 'device_serial'],
  ['Model', 'model'],
  ['App version', 'app_version'],
  ['Status', 'status'],
  ['Last seen', 'last_seen_at'],
  ['IP address', 'ip_address'],
  ['OS version', 'os_version'],
  ['Battery', 'battery_level'],
  ['Network', 'network_type'],
  ['Activated at', 'activated_at'],
] as const

function valueText(value: unknown) {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default function TerminalDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [terminal, setTerminal] = useState<TerminalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch(`/api/platform/terminals/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load terminal')
      setTerminal(body.terminal || body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load terminal')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  if (loading) return <p className="text-sm text-[#8A867C]">Loading terminal diagnostics…</p>
  if (error || !terminal) {
    return <EmptyState title="Terminal unavailable" body={error || 'Terminal not found.'} />
  }

  const seen = String(terminal.last_seen_at || terminal.last_seen || '')
  const restaurantRelation = Array.isArray(terminal.restaurants)
    ? terminal.restaurants[0]
    : terminal.restaurants
  const online =
    typeof terminal.online === 'boolean'
      ? terminal.online
      : false

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/terminals" className="text-sm font-medium text-[#C0392B] hover:underline">
          ← Terminal fleet
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            {String(terminal.terminal_name || terminal.name || terminal.sn || 'Terminal')}
          </h1>
          <HealthBadge status={online ? 'online' : 'offline'} />
        </div>
        <p className="mt-1 text-sm text-[#8A867C]">
          {terminal.restaurant_name || restaurantRelation?.name || 'Device diagnostics'}
        </p>
      </div>

      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="border-b border-[#E8E6E1] px-5 py-4">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Diagnostics</h2>
        </div>
        <dl className="grid gap-px bg-[#E8E6E1] sm:grid-cols-2 xl:grid-cols-3">
          {DIAGNOSTICS.map(([label, key]) => {
            const raw = key === 'last_seen_at' ? terminal.last_seen_at || terminal.last_seen : terminal[key]
            const display =
              key.endsWith('_at') && raw ? new Date(String(raw)).toLocaleString() : valueText(raw)
            return (
              <div key={key} className="bg-white px-5 py-4">
                <dt className="text-xs font-medium text-[#8A867C]">{label}</dt>
                <dd className="mt-1 break-all text-sm font-medium text-[#1A1A1A]">{display}</dd>
              </div>
            )
          })}
        </dl>
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
          Remote device commands are coming soon. These controls are intentionally disabled.
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
