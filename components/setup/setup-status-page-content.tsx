'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getAccessToken } from '@/lib/onboarding/api-client'
import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react'

type SetupStatus = {
  station_screens_enabled: boolean
  category_routing: {
    total: number
    kitchen: number
    bar: number
    both: number
    needs_attention: boolean
  }
  screen_pairing: {
    paired: number
    total: number
  }
  staff: {
    active_count: number
  }
}

type StepState = 'done' | 'attention' | 'not_done'

function StatusIcon({ state }: { state: StepState }) {
  if (state === 'done') return <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
  if (state === 'attention') return <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
  return <Circle className="w-5 h-5 text-gray-300 shrink-0" />
}

function SetupCard({
  state,
  title,
  summary,
  action,
}: {
  state: StepState
  title: string
  summary: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="flex items-start gap-3 border rounded-lg p-4 bg-card">
      <StatusIcon state={state} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{title}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{summary}</p>
      </div>
      {action && (
        <Link href={action.href} className="text-sm font-medium text-[#FF6B35] hover:underline shrink-0">
          {action.label}
        </Link>
      )}
    </div>
  )
}

export function SetupStatusPageContent() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getAccessToken()
        const res = await fetch('/api/admin/setup-status', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load setup status')
        const data = await res.json()
        if (!cancelled) setStatus(data)
      } catch {
        if (!cancelled) setError('Could not load your setup status. Reload to try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  if (error || !status) {
    return <div className="p-8 text-sm text-red-600">{error || 'Something went wrong.'}</div>
  }

  const routing = status.category_routing
  const routingState: StepState =
    routing.total === 0 ? 'not_done' : routing.needs_attention ? 'attention' : 'done'
  const routingSummary =
    routing.total === 0
      ? 'No menu categories yet.'
      : `${routing.kitchen} kitchen / ${routing.bar} bar / ${routing.both} both.` +
        (routing.needs_attention ? ' Nothing goes to the bar — check this is right.' : '')

  const pairingState: StepState = status.screen_pairing.paired > 0 ? 'done' : 'not_done'
  const pairingSummary =
    status.screen_pairing.total === 0
      ? 'No terminals on this venue yet.'
      : `${status.screen_pairing.paired} of ${status.screen_pairing.total} paired to a kitchen or bar screen.`

  const staffState: StepState = status.staff.active_count > 0 ? 'done' : 'not_done'
  const staffSummary =
    status.staff.active_count === 0
      ? 'No staff added yet.'
      : `${status.staff.active_count} active.`

  const flagState: StepState = status.station_screens_enabled ? 'done' : 'not_done'
  const flagSummary = status.station_screens_enabled
    ? 'On.'
    : "Off — nothing below works until this is on. Ask whoever manages your rollout to turn it on."

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Venue setup</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What&apos;s ready for waiter-led service, and what still needs a look. Nothing here has to
          happen in order.
        </p>
      </div>

      <div className="space-y-3">
        <SetupCard
          state={flagState}
          title="Kitchen and bar screens"
          summary={flagSummary}
        />
        <SetupCard
          state={routingState}
          title="Menu routing"
          summary={routingSummary}
          action={{ href: '/menu-management', label: 'Menu Management' }}
        />
        <SetupCard
          state={pairingState}
          title="Screen pairing"
          summary={pairingSummary}
          action={{ href: '/settings', label: 'Settings' }}
        />
        <SetupCard
          state={staffState}
          title="Staff"
          summary={staffSummary}
          action={{ href: '/staff', label: 'Staff' }}
        />
      </div>
    </div>
  )
}
