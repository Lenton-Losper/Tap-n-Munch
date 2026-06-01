'use client'

import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  tabId: string
  restaurantId: string
  onSuccess?: () => void
  className?: string
}

const NOTIFIED_MESSAGE = 'Your waiter has been notified'

export function ReadyToPayTabButton({ tabId, restaurantId, onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (notified) {
    return (
      <p
        className={`flex items-center justify-center gap-2 text-sm font-sans font-medium text-green-700 dark:text-green-400 ${className ?? ''}`}
        role="status"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        {NOTIFIED_MESSAGE}
      </p>
    )
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
        className="w-full bg-green-600 text-white hover:bg-green-700 font-sans font-semibold text-base py-6"
        disabled={loading}
        onClick={async () => {
          if (loading) return
          setError(null)
          setLoading(true)
          console.log('[READY TO PAY TAB] requesting', { tabId, restaurantId })
          try {
            const res = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/ready-to-pay`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ restaurantId }),
            })
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
      className={`flex items-center justify-center gap-2 text-sm font-sans font-medium text-green-700 dark:text-green-400 ${className ?? ''}`}
      role="status"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {NOTIFIED_MESSAGE}
    </p>
  )
}
