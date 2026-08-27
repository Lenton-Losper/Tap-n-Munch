'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

export const TERMINAL_NOTIFIED_MESSAGE = MENU_COPY.readyToPayWaiterNotifiedCardMachine

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
  const [userNotified, setUserNotified] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notified = alreadyNotified || userNotified

  if (notified) {
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
        title={!sessionId ? MENU_COPY.readyToPaySessionNotFound : undefined}
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
              throw new Error(typeof data?.error === 'string' ? data.error : MENU_COPY.readyToPayRequestFailed)
            }
            setUserNotified(true)
            onNotified?.()
          } catch (e: unknown) {
            setError(e instanceof Error ? e.message : MENU_COPY.readyToPaySomethingWentWrong)
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : MENU_COPY.readyToPayButton}
      </Button>
    </div>
  )
}

export function ReadyToPayTerminalNotified({ className }: { className?: string }) {
  return <TerminalNotifiedMessage className={className} />
}
