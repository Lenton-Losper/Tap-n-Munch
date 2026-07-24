'use client'

import { useEffect, useState } from 'react'
import { OpsShell } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

export function OpsLayoutClient({ children }: { children: React.ReactNode }) {
  const [alertCount, setAlertCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getAccessToken()
        const res = await fetch('/api/platform/alerts?active=1', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = (await res.json()) as { alerts?: Array<{ severity: string; ackStatus?: string }> }
        const n = (data.alerts ?? []).filter(
          (a) => a.severity === 'critical' && a.ackStatus !== 'resolved' && a.ackStatus !== 'acknowledged',
        ).length
        if (!cancelled) setAlertCount(n)
      } catch {
        // ignore — badge stays 0
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return <OpsShell alertCount={alertCount}>{children}</OpsShell>
}
