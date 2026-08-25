'use client'

import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { deriveIsCounterService, serviceCopy } from '@/lib/customer-copy/service-model'
import { useRestaurant } from '@/contexts/restaurant-context'
import { getSessionToken } from '@/lib/fetch-with-session'
import { heldSessionIds } from '@/lib/tab-storage'
import { getCurrentSession } from '@/lib/session'

type Props = {
  orderId: string
  className?: string
}

/**
 * SIGNED 2026-08-25 as a counter/table PAIR, so it can no longer be a module constant: the sentence
 * depends on the venue. Both components below resolve it through `serviceCopy`, the same way the
 * four screens under app/menu do.
 *
 * HOW IT WAS FOUND, because no gate could have found it. The sentence lived here as a bare literal,
 * `NOTIFIED_MESSAGE`, byte-identical to the one the order-confirmation page rendered for the same
 * state — two copies of one string on two surfaces, and THIS copy invisible to every copy gate,
 * because `scripts/check-menu-copy-sourced.mjs` scans `app/menu` and this file is under
 * `components/`. It surfaced only from enumerating what #121 made reachable.
 *
 * Neither copy had ever been seen by a customer: the cash button's write raised 42501 on every
 * press, so the component always took its error path. Fixing #121 made both reachable at once,
 * which is why the pair had to land WITH it and not after.
 *
 * Safe to call `useRestaurant` here: both exports render only from
 * app/menu/[restaurantId]/order-confirmation/[orderId]/page.tsx, which sits under
 * app/menu/[restaurantId]/layout.tsx where the provider lives.
 */

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
  const { restaurant } = useRestaurant()
  const copy = serviceCopy(deriveIsCounterService({ restaurant }))
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
        {copy.staffHasBeenNotified}
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
  const { restaurant } = useRestaurant()
  const copy = serviceCopy(deriveIsCounterService({ restaurant }))
  return (
    <p
      className={`flex items-center justify-center gap-2 text-sm font-sans font-medium text-green-700 dark:text-green-400 ${className ?? ''}`}
      role="status"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {copy.staffHasBeenNotified}
    </p>
  )
}
