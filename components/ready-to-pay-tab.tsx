'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'

export const TAB_READY_NOTIFIED_MESSAGE =
  'Waiter has been notified — the card machine is on its way'

type Props = {
  tabId: string
  restaurantId: string
  onSuccess?: () => void
  className?: string
  /** When true, skip API call and show static notified message */
  tabAlreadyReady?: boolean
}

export function ReadyToPayTabButton({
  tabId,
  restaurantId,
  onSuccess,
  className,
  tabAlreadyReady = false,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(tabAlreadyReady)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (tabAlreadyReady) setNotified(true)
  }, [tabAlreadyReady])

  if (tabAlreadyReady || notified) {
    return <ReadyToPayTabNotified className={className} />
  }

  return (
    <div className={className}>
      {error && (
        <p className="text-sm text-destructive font-sans mb-2 text-center" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        className="w-full py-4 px-6 text-base font-semibold text-white text-center bg-[#16A34A] hover:bg-green-700 rounded-xl whitespace-normal h-auto min-h-[3rem]"
        disabled={loading}
        onClick={async () => {
          if (loading || tabAlreadyReady || notified) {
            if (tabAlreadyReady || notified) onSuccess?.()
            return
          }
          setError(null)
          setLoading(true)
          console.log('[READY TO PAY TAB] requesting', { tabId, restaurantId })
          try {
            const res = await fetchWithSession(
              `/api/tabs/${encodeURIComponent(tabId)}/ready-to-pay`,
              restaurantId,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ restaurantId }),
              }
            )
            if (res.status === 410) {
              handleSessionExpired(restaurantId)
              return
            }
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
              throw new Error(data?.error || `Request failed (${res.status})`)
            }
            console.log('[READY TO PAY TAB] success', data)
            setNotified(true)
            onSuccess?.()
          } catch (err) {
            console.error('[READY TO PAY TAB] failed', err)
            setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : 'Ready to Pay'}
      </Button>
    </div>
  )
}

export function ReadyToPayTabNotified({ className }: { className?: string }) {
  return (
    <p
      className={`flex items-center justify-center gap-2 text-sm font-semibold text-[#16A34A] text-center leading-relaxed ${className ?? ''}`}
      role="status"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {TAB_READY_NOTIFIED_MESSAGE}
    </p>
  )
}
