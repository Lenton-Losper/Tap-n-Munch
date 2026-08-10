'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChefHat, Star } from 'lucide-react'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { getCurrentSession } from '@/lib/session'
import { clearActiveOrderBannerState } from '@/lib/tab-storage'
import { ReadyToPayTerminalButton, ReadyToPayTerminalNotified } from '@/components/ready-to-pay-terminal'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import {
  fetchGuestOrderById,
  fetchGuestOrdersBySession,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import { readTabSessionId } from '@/lib/tab-storage'
import {
  isBannerEligibleOrder,
  normalizeOrderStatusForDisplay,
} from '@/lib/orders/active-order-visibility'

const GREEN = '#27AE60'

type Props = {
  restaurantId: string
  tableNumber: number
  currency?: string
  tabId?: string
  isKiosk?: boolean
  customerName?: string
  sessionId?: string
}

type TrackerStep = {
  key: string
  label: string
  complete: boolean
  Icon: typeof Check
}

function buildTrackerSteps(order: Record<string, any>): TrackerStep[] {
  // Normalised, not raw: the terminal writes `confirmed` where the dashboard writes `accepted`,
  // and an unmapped status silently draws the bar as LESS far along than the order really is.
  const status = normalizeOrderStatusForDisplay(order.status)
  const paid = String(order.payment_status || '').toLowerCase() === 'paid'
  const waitingReview = status === 'waiting_review'
  const receivedOrBeyond =
    !waitingReview &&
    ['pending', 'accepted', 'preparing', 'ready', 'ready_for_terminal', 'completed'].includes(status)
  const acceptedOrBeyond = ['accepted', 'preparing', 'ready', 'ready_for_terminal', 'completed'].includes(
    status,
  )
  const preparingOrBeyond =
    ['preparing', 'ready', 'ready_for_terminal', 'completed'].includes(status) ||
    (status === 'accepted' && paid)
  const readyOrBeyond = ['ready', 'ready_for_terminal', 'completed'].includes(status)

  return [
    {
      key: 'waiting_review',
      label: 'Waiting for Review',
      complete: !waitingReview,
      Icon: Check,
    },
    { key: 'received', label: 'Received', complete: receivedOrBeyond || paid, Icon: Check },
    { key: 'accepted', label: 'Accepted', complete: acceptedOrBeyond || paid, Icon: Check },
    { key: 'preparing', label: 'Preparing', complete: preparingOrBeyond, Icon: ChefHat },
    { key: 'ready', label: 'Ready', complete: readyOrBeyond, Icon: Star },
    { key: 'paid', label: 'Paid', complete: paid, Icon: Star },
  ]
}

function ReadyToPayCardButton({
  restaurantId,
  orderId,
  tableNumber,
  tabId,
  alreadyNotified,
}: {
  restaurantId: string
  orderId: string
  tableNumber: number
  tabId?: string
  alreadyNotified?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(Boolean(alreadyNotified))

  if (notified) {
    return (
      <span className="text-xs font-semibold text-[#27AE60] whitespace-nowrap">
        Waiter notified
      </span>
    )
  }

  return (
    <button
      type="button"
      disabled={loading}
      onClick={async () => {
        if (loading) return
        setLoading(true)
        try {
          if (tabId) {
            const res = await fetchWithSession(
              `/api/tabs/${encodeURIComponent(tabId)}/ready-to-pay`,
              restaurantId,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ restaurantId, paymentPreference: 'card' }),
              }
            )
            if (res.status === 410) {
              handleSessionExpired(restaurantId)
              return
            }
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.error || 'Request failed')
          } else {
            const sessionId = getCurrentSession()
            const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/ready-for-terminal`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                restaurantId,
                tableNumber,
                session_id: sessionId,
              }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.error || 'Request failed')
          }
          setNotified(true)
        } catch {
          setLoading(false)
        }
      }}
      className="shrink-0 rounded-lg bg-[#27AE60] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {loading ? 'Sending…' : 'Ready to Pay'}
    </button>
  )
}

/** Every session id this customer's orders could have been submitted with. See readTabSessionId. */
function collectSessionIds(sessionId?: string): string[] {
  return [...new Set(
    [
      String(sessionId || '').trim(),
      String(getCurrentSession() || '').trim(),
      String(readTabSessionId() || '').trim(),
    ].filter(Boolean),
  )]
}

function belongsToTable(order: Record<string, any>, tableNumber: number): boolean {
  if (!tableNumber) return true
  return Number(order.table_number) === Number(tableNumber)
}

function sortNewestFirst(orders: Record<string, any>[]): Record<string, any>[] {
  return [...orders].sort((a, b) => {
    const aMs = a.placed_at ? new Date(String(a.placed_at)).getTime() : 0
    const bMs = b.placed_at ? new Date(String(b.placed_at)).getTime() : 0
    return bMs - aMs
  })
}

export function MenuOrderStatusTracker({
  restaurantId,
  tableNumber,
  currency = 'N$',
  tabId,
  isKiosk,
  customerName,
  sessionId,
}: Props) {
  const { activeOrder, loading, error } = useActiveOrders(
    restaurantId,
    tableNumber,
    isKiosk,
    customerName,
    sessionId
  )
  const [orders, setOrders] = useState<Record<string, any>[]>([])
  const [ordersLoaded, setOrdersLoaded] = useState(false)

  const persistedOrderId =
    typeof window !== 'undefined'
      ? String(
          sessionStorage.getItem('last_order_id') || sessionStorage.getItem('flashtap_return_order_id') || ''
        ).trim()
      : ''

  /* eslint-disable react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope */
  useEffect(() => {
    if (!restaurantId) {
      setOrders([])
      setOrdersLoaded(true)
      return
    }

    let cancelled = false

    /**
     * Resolve EVERY round the customer still has in progress.
     *
     * This used to read one `last_order_id` from sessionStorage, which the cart overwrites on
     * every submit -- so on a tab with three rounds only the third was ever visible (#134).
     * The session is what identifies the customer, so ask by session and show them all.
     * The stored id remains a fallback for a customer whose session ids are missing.
     */
    const fetchActiveRounds = async () => {
      const sessionIds = collectSessionIds(sessionId)

      let resolved: Record<string, any>[] = []
      if (sessionIds.length > 0) {
        const { orders: rows } = await fetchGuestOrdersBySession({
          restaurantId,
          sessionId: sessionIds[0],
          sessionIds,
          excludeSettlement: true,
        })
        resolved = (rows || []) as Record<string, any>[]
      } else if (persistedOrderId) {
        const single = await fetchGuestOrderById(persistedOrderId, {
          restaurantId,
          tableNumber,
          sessionId: sessionId || getCurrentSession() || undefined,
        })
        resolved = single ? [single as Record<string, any>] : []
      }

      if (cancelled) return

      const active = sortNewestFirst(
        resolved
          .map((o) => ({ ...o, id: String(o.id) }))
          .filter((o) => belongsToTable(o, tableNumber))
          .filter((o) => isBannerEligibleOrder(o)),
      )

      // Only wipe the stored order id when nothing at all is live -- clearing it while another
      // round is still cooking would hide that round from the landing-page banner too.
      if (active.length === 0) clearActiveOrderBannerState()

      setOrders(active)
      setOrdersLoaded(true)
    }

    void fetchActiveRounds().catch(() => {
      if (!cancelled) {
        setOrders([])
        setOrdersLoaded(true)
      }
    })

    const interval = window.setInterval(() => {
      void fetchActiveRounds()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [restaurantId, tableNumber, persistedOrderId, sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const visibleOrders = useMemo(() => {
    const byId = new Map<string, Record<string, any>>()
    for (const o of orders) byId.set(String(o.id), o)
    // useActiveOrders polls the table endpoint on its own cadence; fold its result in so a
    // just-placed round appears without waiting for the next by-session poll.
    if (activeOrder && isBannerEligibleOrder(activeOrder as Record<string, any>)) {
      const a = activeOrder as unknown as Record<string, any>
      if (belongsToTable(a, tableNumber)) {
        const id = String(a.id)
        byId.set(id, { ...(byId.get(id) || {}), ...a, id })
      }
    }
    return sortNewestFirst([...byId.values()])
  }, [orders, activeOrder, tableNumber])

  if (loading && !ordersLoaded) return null
  if (error) return null
  if (visibleOrders.length === 0) return null

  return (
    <section className="border-b border-gray-200 bg-white px-4 py-4">
      <div className="mx-auto max-w-4xl space-y-4">
        {visibleOrders.map((order, index) => (
          <OrderStatusRow
            key={String(order.id)}
            order={order}
            restaurantId={restaurantId}
            tableNumber={tableNumber}
            currency={currency}
            tabId={tabId}
            /**
             * Deliberate: the Ready to Pay control stays on the newest round only, exactly as
             * before. Rendering one per round would multiply a payment-notification action
             * across orders, which is a payment-flow change rather than a display fix.
             */
            showPayControl={index === 0}
          />
        ))}
      </div>
    </section>
  )
}

function OrderStatusRow({
  order: currentOrder,
  restaurantId,
  tableNumber,
  currency,
  tabId,
  showPayControl,
}: {
  order: Record<string, any>
  restaurantId: string
  tableNumber: number
  currency: string
  tabId?: string
  showPayControl: boolean
}) {
  const steps = buildTrackerSteps(currentOrder)
  const currentIndex = steps.findIndex((step) => !step.complete)
  const activeIndex = currentIndex === -1 ? steps.length - 1 : currentIndex

  const orderNumber = currentOrder.order_number || currentOrder.id.slice(-6).toUpperCase()
  const orderTotal = Number(currentOrder.total) || 0
  /**
   * Two readings of the same field, deliberately.
   *
   * `displayStatus` is normalised and drives what the customer is TOLD. `statusLower` stays raw
   * and drives which payment controls exist, because those POST to ready-for-terminal /
   * ready-to-pay. Normalising there would hand a terminal-`confirmed` order a Ready to Pay
   * button it has never had -- a payment-surface change riding along inside a display fix.
   */
  const displayStatus = normalizeOrderStatusForDisplay(currentOrder.status)
  const statusLower = String(currentOrder.status || '').toLowerCase()
  const payChannel = String(currentOrder.payment_channel || '').toLowerCase()
  const isPreparing =
    displayStatus === 'preparing' ||
    (displayStatus === 'accepted' && steps[3].complete && !steps[4].complete)

  const showReadyToPay =
    showPayControl && (statusLower === 'ready' || statusLower === 'accepted')
  const terminalAlreadyNotified =
    statusLower === 'ready_for_terminal' || currentOrder.customer_ready_to_pay === true
  const showTerminalFlow =
    showPayControl &&
    payChannel === 'terminal' &&
    String(currentOrder.payment_status || '').toLowerCase() === 'pending' &&
    statusLower !== 'completed'

  return (
    <div>
      <div>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-black">
              Order #{orderNumber}
            </p>
            <p className="text-sm text-gray-600">
              Total: {currency}
              {orderTotal.toFixed(2)}
            </p>
          </div>

          {showReadyToPay && !showTerminalFlow ? (
            <ReadyToPayCardButton
              restaurantId={restaurantId}
              orderId={String(currentOrder.id)}
              tableNumber={tableNumber}
              tabId={tabId}
              alreadyNotified={terminalAlreadyNotified}
            />
          ) : null}

          {showTerminalFlow ? (
            <div className="shrink-0">
              {terminalAlreadyNotified ? (
                <ReadyToPayTerminalNotified />
              ) : (
                <ReadyToPayTerminalButton
                  restaurantId={restaurantId}
                  orderId={String(currentOrder.id)}
                  tableNumber={tableNumber}
                  sessionId={getCurrentSession()}
                  alreadyNotified={terminalAlreadyNotified}
                  className="[&_button]:rounded-lg [&_button]:bg-[#27AE60] [&_button]:px-4 [&_button]:py-2 [&_button]:text-sm"
                />
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-1">
          {steps.map((step, index) => {
            const isComplete = step.complete
            const isCurrent = index === activeIndex && !isComplete
            const Icon = step.Icon
            return (
              <div key={step.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="relative flex h-8 w-8 items-center justify-center">
                  {isCurrent ? (
                    <span
                      className="absolute inset-0 animate-ping rounded-full opacity-40"
                      style={{ backgroundColor: GREEN }}
                    />
                  ) : null}
                  <div
                    className={`relative flex h-8 w-8 items-center justify-center rounded-full border-2 ${
                      isComplete
                        ? 'border-[#27AE60] bg-[#27AE60] text-white'
                        : isCurrent
                          ? 'border-[#27AE60] bg-white text-[#27AE60]'
                          : 'border-gray-300 bg-gray-100 text-gray-400'
                    }`}
                  >
                    {isComplete ? (
                      <Check className="h-4 w-4" strokeWidth={2.5} />
                    ) : (
                      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                    )}
                  </div>
                </div>
                <span
                  className={`text-center text-[10px] font-medium leading-tight sm:text-xs ${
                    isComplete || isCurrent ? 'text-black' : 'text-gray-400'
                  }`}
                >
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>

        {isPreparing ? (
          <p className="mt-3 text-center text-xs text-gray-500">
            Estimated prep time: 15–20 minutes
          </p>
        ) : null}
      </div>
    </div>
  )
}
