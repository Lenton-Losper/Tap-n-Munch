'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export const TERMINAL_NOTIFIED_MESSAGE =
  'Waiter has been notified — the card machine is on its way'

type Props = {
  restaurantId: string
  orderId: string
  tableNumber: number
  sessionId: string | null
  className?: string
  onNotified?: () => void
  /** Order already marked ready_for_terminal or customer_ready_to_pay */
  alreadyNotified?: boolean
}

function TerminalNotifiedMessage({ className }: { className?: string }) {
  return (
    <p
      className={`text-center text-sm font-semibold text-[#16A34A] leading-relaxed ${className ?? ''}`}
      role="status"
    >
      {TERMINAL_NOTIFIED_MESSAGE}
    </p>
  )
}

/**
 * Customer CTA: notify staff that the card terminal can be brought to the table.
 */
export function ReadyToPayTerminalButton({
  restaurantId,
  orderId,
  tableNumber,
  sessionId,
  className,
  onNotified,
  alreadyNotified = false,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(alreadyNotified)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (alreadyNotified) setNotified(true)
  }, [alreadyNotified])

  if (alreadyNotified || notified) {
    return <TerminalNotifiedMessage className={className} />
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
        disabled={!sessionId || loading}
        title={!sessionId ? 'Session not found — open this page from the same device you ordered on.' : undefined}
        onClick={async () => {
          if (!sessionId || loading || alreadyNotified || notified) {
            if (alreadyNotified || notified) onNotified?.()
            return
          }
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
            onNotified?.()
          } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Something went wrong')
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : 'Ready to Pay'}
      </Button>
    </div>
  )
}

export function ReadyToPayTerminalNotified({ className }: { className?: string }) {
  return <TerminalNotifiedMessage className={className} />
}
