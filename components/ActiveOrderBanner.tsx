// @ts-nocheck
'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { cn } from '@/lib/utils'
import { getSessionInfo, getCurrentSession } from '@/lib/session'
import {
  ReadyToPayTerminalButton,
  ReadyToPayTerminalNotified,
} from '@/components/ready-to-pay-terminal'
import { clearActiveOrderBannerState, heldSessionIds } from '@/lib/tab-storage'
import { fetchGuestOrderById, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import {
  isBannerEligibleOrder,
  normalizeOrderStatusForDisplay,
} from '@/lib/orders/active-order-visibility'
import { orderIdentityLabel } from '@/lib/orders/order-identity'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'

/**
 * PART 3: Active Order Banner
 *
 * Banner shows orders for this TABLE, not browser session.
 * Data via guest API + polling (Stage 2 RLS lockdown will block guest Realtime on orders).
 */
export function ActiveOrderBanner() {
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()
  const restaurantId = params?.restaurantId as string | undefined
  const tableNumberParam = searchParams?.get('table')

  const sessionInfo = typeof window !== 'undefined' ? getSessionInfo() : null
  const sessionTableNumber = sessionInfo?.table ? Number(sessionInfo.table) : undefined

  const tableNumber =
    sessionTableNumber && Number.isFinite(sessionTableNumber) && sessionTableNumber > 0
      ? sessionTableNumber
      : tableNumberParam
        ? parseInt(tableNumberParam, 10)
        : undefined

  // useActiveOrders fails closed without a session id (it will not show table-wide orders to an
  // unscoped caller), so omitting this made the banner permanently inert -- it never even
  // issued a request. The customer's own session is the correct scope.
  const sessionId = sessionInfo?.sessionId || (typeof window !== 'undefined' ? getCurrentSession() : null)

  const { activeOrder, loading, error } = useActiveOrders(
    restaurantId,
    tableNumber,
    undefined,
    undefined,
    sessionId || undefined,
  )
  const [lastOrder, setLastOrder] = useState<Record<string, any> | null>(null)
  const [lastOrderLoaded, setLastOrderLoaded] = useState(false)

  /**
   * #311: a ticking clock, only so the waiting figure does not sit frozen.
   *
   * Kept separate from the order poll (GUEST_ORDER_POLL_MS) because it answers a different
   * question -- the poll asks whether the ORDER changed, this asks what time it is now. Coupling
   * them would either re-render the wait figure only as often as the network allows, or poll the
   * API every minute to update a number we already have locally.
   *
   * One minute, because the figure is rendered in whole minutes; a faster tick would re-render
   * without ever changing what the customer reads.
   */
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const persistedOrderId =
    typeof window !== 'undefined'
      ? String(
          sessionStorage.getItem('last_order_id') || sessionStorage.getItem('flashtap_return_order_id') || ''
        ).trim()
      : ''

  /* eslint-disable react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope */
  useEffect(() => {
    if (!restaurantId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }
    const orderId = persistedOrderId
    if (!orderId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }

    let cancelled = false

    const fetchLastOrder = async () => {
      const data = await fetchGuestOrderById(orderId, {
        restaurantId,
        tableNumber,
        sessionIds: heldSessionIds(),
      })
      if (cancelled) return
      if (!data) {
        clearActiveOrderBannerState()
        setLastOrder(null)
        setLastOrderLoaded(true)
        return
      }
      if (tableNumber && Number(data.table_number) !== Number(tableNumber)) {
        setLastOrder(null)
        setLastOrderLoaded(true)
        return
      }
      if (!isBannerEligibleOrder(data)) {
        clearActiveOrderBannerState()
        setLastOrder(null)
        setLastOrderLoaded(true)
        return
      }
      setLastOrder({ id: String(data.id), ...data })
      setLastOrderLoaded(true)
    }

    void fetchLastOrder().catch(() => {
      if (!cancelled) {
        setLastOrder(null)
        setLastOrderLoaded(true)
      }
    })

    const interval = window.setInterval(() => {
      void fetchLastOrder()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [restaurantId, tableNumber, persistedOrderId])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (loading && !lastOrderLoaded) {
    return null
  }

  if (error) {
    console.error('❌ ActiveOrderBanner error:', error)
    return null
  }

  const currentOrder =
    (lastOrder && isBannerEligibleOrder(lastOrder) ? lastOrder : null) ||
    (activeOrder && isBannerEligibleOrder(activeOrder) ? activeOrder : null)

  if (!currentOrder) {
    return null
  }

  // #308: never a UUID tail. One answer, in lib/orders/order-identity.ts.
  const orderIdentity = orderIdentityLabel(currentOrder)

  const payChannel = String(currentOrder.payment_channel || '').toLowerCase()

  const getStatusInfo = (status: string, paymentStatus: string, channel: string) => {
    // Normalised: `confirmed` is the terminal's `accepted`, `accepting` is still pre-acceptance.
    const s = normalizeOrderStatusForDisplay(status)
    const p = String(paymentStatus || '').toLowerCase()
    const ch = String(channel || '').toLowerCase()
    if (p === 'pending' && s === 'pending' && ch === 'terminal') {
      return { text: 'Order received — tap below when ready for card machine', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'pending' && s === 'pending') {
      return { text: 'Order received - Awaiting payment', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'pending' && s === 'ready_for_terminal') {
      return { text: 'Waiter notified — card machine on the way', pulse: true, tone: 'preparing' as const }
    }
    if (p === 'cash_pending' && s === 'pending') {
      return { text: 'Order received - Pay at counter', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'paid' && s === 'accepted') {
      return { text: 'Order accepted - Being prepared', pulse: true, tone: 'preparing' as const }
    }
    if (p === 'paid' && s === 'ready') {
      return { text: 'Your order is ready for collection', pulse: false, tone: 'ready' as const }
    }
    if (p === 'paid' && s === 'completed') {
      return { text: 'Payment confirmed - Thank you!', pulse: false, tone: 'completed' as const }
    }
    // Statuses this banner only began showing once the eligibility list was widened. Without
    // these they reach the fallback below and read "Order in progress", which says nothing.
    // Scoped to exactly those statuses -- the unpaid `accepted`/`ready` paths were already
    // reachable before and are left as they were.
    if (s === 'waiting_review') {
      /**
       * #311, ruled B: TELL the customer how long they have been waiting.
       *
       * An unanswered request has no timeout, no escalation and no expiry — the cron sweeps
       * `orders` only. Production has held one open for 480 hours while the customer was shown a
       * sentence that never changed. An elapsed figure is the difference between "the restaurant
       * is looking at this" and "this has been sitting for forty minutes", and only the customer
       * can act on the second one — by talking to staff.
       *
       * DISPLAY ONLY. The record is untouched and remains exactly as stranded as before; C
       * (withdraw) has no status to write to and D (auto-expire) is blocked behind #215. This does
       * not imply either is happening.
       *
       * Suppressed under a minute so the banner does not flicker "0 min" the instant an order is
       * placed, which would read as a stall rather than as a normal wait.
       */
      const placedAtMs = Date.parse(String(currentOrder.placed_at ?? ''))
      const waitedMin = Number.isFinite(placedAtMs)
        ? Math.floor((nowMs - placedAtMs) / 60000)
        : 0
      const base = 'Order sent - waiting for the restaurant to confirm'
      return {
        text:
          waitedMin >= 1
            ? `${base} · ${QR_REDESIGN_PENDING_COPY.waitingForRestaurantElapsed.replace(
                '{minutes}',
                String(waitedMin),
              )}`
            : base,
        pulse: true,
        tone: 'neutral' as const,
      }
    }
    if (s === 'preparing') {
      return { text: 'Order accepted - Being prepared', pulse: true, tone: 'preparing' as const }
    }
    return { text: 'Order in progress', pulse: false, tone: 'neutral' as const }
  }

  const statusInfo = getStatusInfo(currentOrder.status, currentOrder.payment_status, payChannel)

  const orderStatusLower = String(currentOrder.status || '').toLowerCase()
  const terminalAlreadyNotified =
    orderStatusLower === 'ready_for_terminal' ||
    currentOrder.customer_ready_to_pay === true
  const showReadyToPayTerminal =
    payChannel === 'terminal' &&
    String(currentOrder.payment_status || '').toLowerCase() === 'pending' &&
    orderStatusLower !== 'completed'

  const handleClick = () => {
    if (restaurantId && tableNumber) {
      router.push(`/menu/${restaurantId}/receipt?table=${tableNumber}`)
    } else {
      router.push(`/order-confirmation?orderId=${currentOrder.id}`)
    }
  }

  const toneClass =
    statusInfo.tone === 'preparing'
      ? 'bg-[#FF6B35] text-white border-[#e55a28]'
      : statusInfo.tone === 'ready'
      ? 'bg-green-600 text-white border-green-700'
      : statusInfo.tone === 'completed'
      ? 'bg-muted text-foreground border-border'
      : 'bg-black text-white border-border'

  return (
    <div
      className={cn(
        'sticky top-0 z-[60] transition-all border-b',
        toneClass,
        statusInfo.pulse && 'animate-pulse'
      )}
    >
      <div className="container mx-auto px-4 py-3 space-y-3">
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleClick()
            }
          }}
          className="flex cursor-pointer items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div>
              <p className="font-semibold text-sm">
                {orderIdentity} {statusInfo.text}
              </p>
              <p className="text-xs opacity-90">
                {currentOrder.total && `Total: N$${Number(currentOrder.total).toFixed(2)} • `}
                Tap to view receipt
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-90">View Receipt →</span>
          </div>
        </div>
        {showReadyToPayTerminal && restaurantId && (
          <div onClick={(e) => e.stopPropagation()} className="pb-1">
            {terminalAlreadyNotified ? (
              <ReadyToPayTerminalNotified className="text-white/95" />
            ) : (
              <ReadyToPayTerminalButton
                restaurantId={restaurantId}
                orderId={String(currentOrder.id)}
                tableNumber={Number(currentOrder.table_number) || Number(tableNumber) || 0}
                sessionId={getCurrentSession()}
                alreadyNotified={terminalAlreadyNotified}
                className="[&_button]:bg-white [&_button]:text-white [&_button]:hover:bg-white/90"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
