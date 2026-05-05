'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

type Props = {
  restaurantId: string
  orderId: string
  tableNumber: number
  sessionId: string | null
  className?: string
}

/**
 * Customer CTA: notify staff that the card terminal can be brought to the table.
 */
export function ReadyToPayTerminalButton({ restaurantId, orderId, tableNumber, sessionId, className }: Props) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (notified) {
    return (
      <p className="text-sm font-sans font-medium text-green-700 dark:text-green-400" role="status">
        Waiter has been notified — card machine coming!
      </p>
    )
  }

  return (
    <div className={className}>
      {error && (
        <p className="text-sm text-destructive font-sans mb-2" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold"
        disabled={!sessionId || loading}
        title={!sessionId ? 'Session not found — open this page from the same device you ordered on.' : undefined}
        onClick={async () => {
          if (!sessionId || loading) return
          setError(null)
          setLoading(true)
          try {
            const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/ready-for-terminal`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ restaurantId, tableNumber, session_id: sessionId }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
              throw new Error(typeof data?.error === 'string' ? data.error : 'Request failed')
            }
            setNotified(true)
          } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Something went wrong')
          } finally {
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : 'Ready to Pay — Tap when waiter can bring card machine'}
      </Button>
    </div>
  )
}
