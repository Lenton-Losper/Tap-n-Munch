'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'
import type { AlertSeverity, PlatformAlert } from '@/lib/platform/dashboard'

const FILTERS: Array<'all' | AlertSeverity> = ['all', 'critical', 'warning', 'info']

const severityStyle: Record<AlertSeverity, string> = {
  critical: 'border-red-200 bg-red-50 text-red-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<PlatformAlert[]>([])
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updating, setUpdating] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/alerts', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load alerts')
      setAlerts(Array.isArray(body.alerts) ? body.alerts : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load alerts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  const updateStatus = async (
    alertKey: string,
    status: 'acknowledged' | 'resolved',
  ) => {
    setUpdating(alertKey)
    setError('')
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/alerts', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ alertKey, status }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to update alert')
      setAlerts((current) =>
        current.map((alert) =>
          alert.key === alertKey ? { ...alert, ackStatus: status } : alert,
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update alert')
    } finally {
      setUpdating(null)
    }
  }

  const visible = alerts.filter((alert) => filter === 'all' || alert.severity === filter)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Alerts</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Operational issues across payments, terminals, receipts, and support.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[#E8E6E1]">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => setFilter(item)}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              filter === item
                ? 'border-[#C0392B] text-[#1A1A1A]'
                : 'border-transparent text-[#8A867C] hover:text-[#1A1A1A]'
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[#8A867C]">Loading alerts…</p>
      ) : visible.length === 0 ? (
        <EmptyState title="No alerts" body="Nothing matches this severity filter." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <ul className="divide-y divide-[#E8E6E1]">
            {visible.map((alert) => (
              <li key={alert.key} className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={severityStyle[alert.severity]}>
                      {alert.severity}
                    </Badge>
                    <h2 className="text-sm font-semibold text-[#1A1A1A]">{alert.title}</h2>
                    <Badge variant="outline" className="border-[#E8E6E1] text-[#8A867C]">
                      {alert.ackStatus || 'open'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-[#5C574E]">{alert.detail}</p>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#8A867C]">
                    {alert.restaurantName ? <span>{alert.restaurantName}</span> : null}
                    <span>{new Date(alert.createdAt).toLocaleString()}</span>
                    {alert.href ? (
                      <Link href={alert.href} className="font-medium text-[#C0392B] hover:underline">
                        Open context
                      </Link>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updating === alert.key || alert.ackStatus === 'acknowledged'}
                    onClick={() => void updateStatus(alert.key, 'acknowledged')}
                    className="border-[#E8E6E1]"
                  >
                    Acknowledge
                  </Button>
                  <Button
                    size="sm"
                    disabled={updating === alert.key || alert.ackStatus === 'resolved'}
                    onClick={() => void updateStatus(alert.key, 'resolved')}
                    className="bg-[#C0392B] text-white hover:bg-[#A93226]"
                  >
                    Resolve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
