'use client'

import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import { getSessionToken } from '@/lib/fetch-with-session'
import { heldSessionIds } from '@/lib/tab-storage'
import { getCurrentSession } from '@/lib/session'

type Props = {
  orderId: string
  className?: string
}

/**
 * #121. This string was a bare literal here, `NOTIFIED_MESSAGE`, identical to
 * `MENU_COPY.staffHasBeenNotifiedThey` which the order-confirmation page renders for the same
 * state. Two copies of one sentence, on two surfaces, one of them invisible to every copy gate —
 * `scripts/check-menu-copy-sourced.mjs` scans `app/menu`, and this file is under `components/`.
 *
 * Pointed at the existing key rather than reworded: byte-identical, so nothing a customer reads
 * changes today. What changes is that when the owner splits this string counter/table — it
 * promises a waiter at two counter-service venues and that pairing is tracked on #121 — the split
 * reaches both surfaces instead of one.
 */
const NOTIFIED_MESSAGE = MENU_COPY.staffHasBeenNotifiedThey

/**
 * Customer CTA for cash orders: notify staff the customer is ready to pay.
 *
 * #121 — THIS USED TO WRITE STRAIGHT TO THE DATABASE with the browser anon client:
 *
 *     await supabase.from('orders').update({ customer_ready_to_pay: true }).eq('id', orderId)
 *
 * It never once worked. The only anon UPDATE policy on `orders` carries
 * `WITH CHECK (status = 'ready_for_terminal')`, which a cash order's status never satisfies —
 * 490 cash orders on production, zero ever flagged. Worse than failing: on staging RLS filtered
 * the row and PostgREST reported success, so `updateError` was null and this component took its
 * success path. The customer was told staff were coming while nothing had been recorded.
 *
 * Now it POSTs to a service-role route, the same shape the card sibling has always used. A real
 * status code comes back, so the success path is reached only when the write actually landed.
 */
export function ReadyToPayCashButton({ orderId, className }: Props) {
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
          try {
            /**
             * Plain `fetch`, not `fetchWithSession`, and the difference is deliberate.
             * `fetchWithSession` calls `handleSessionExpired` on a 410, which EVICTS THE CART.
             * This route never answers 410 — but a helper whose failure mode is "throw the
             * customer's basket away" does not belong on a button whose whole job is a one-bit
             * flag. The token is attached by hand instead.
             */
            const token = getSessionToken()
            const res = await fetch(
              `/api/orders/${encodeURIComponent(orderId)}/ready-to-pay-cash`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(token ? { 'x-session-token': token } : {}),
                },
                /**
                 * EVERY id this browser holds. The app mints two, in two storages, and nothing
                 * syncs them; an order carries whichever the placing screen had. Sending one is
                 * how the customer's own order comes back as "not yours".
                 */
                body: JSON.stringify({
                  session_ids: [getCurrentSession(), ...heldSessionIds()].filter(Boolean),
                }),
              },
            )
            const data = await res.json().catch(() => ({}) as Record<string, unknown>)
            if (!res.ok) {
              throw new Error(
                typeof (data as { error?: unknown }).error === 'string'
                  ? String((data as { error?: unknown }).error)
                  : 'Request failed',
              )
            }
            setNotified(true)
          } catch {
            setError('Something went wrong. Please try again.')
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : 'Ready to Pay'}
      </Button>
    </div>
  )
}

export function ReadyToPayCashNotified({ className }: { className?: string }) {
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
