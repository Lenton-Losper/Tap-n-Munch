'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChefHat, Star } from 'lucide-react'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { getCurrentSession } from '@/lib/session'
import { supabase } from '@/lib/supabase/client'
import { clearActiveOrderBannerState } from '@/lib/tab-storage'
import { ReadyToPayTerminalButton, ReadyToPayTerminalNotified } from '@/components/ready-to-pay-terminal'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'

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

function isBannerEligibleOrder(order: Record<string, any> | null) {
  if (!order) return false
  if (order.is_closed === true || order.table_closed === true) return false
  const status = String(order.status || '').toLowerCase()
  if (status === 'completed' || status === 'cancelled') return false
  return ['pending', 'accepted', 'preparing', 'ready', 'ready_for_terminal'].includes(status)
}

function buildTrackerSteps(order: Record<string, any>): TrackerStep[] {
  const status = String(order.status || '').toLowerCase()
  const paid = String(order.payment_status || '').toLowerCase() === 'paid'

  const acceptedOrBeyond = ['accepted', 'preparing', 'ready', 'ready_for_terminal', 'completed'].includes(
    status
  )
  const preparingOrBeyond =
    ['preparing', 'ready', 'ready_for_terminal', 'completed'].includes(status) ||
    (status === 'accepted' && paid)
  const readyOrBeyond = ['ready', 'ready_for_terminal', 'completed'].includes(status)

  return [
    { key: 'received', label: 'Received', complete: true, Icon: Check },
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
  const [lastOrder, setLastOrder] = useState<Record<string, any> | null>(null)
  const [lastOrderLoaded, setLastOrderLoaded] = useState(false)
  const [liveOrder, setLiveOrder] = useState<Record<string, any> | null>(null)

  const persistedOrderId =
    typeof window !== 'undefined'
      ? String(
          sessionStorage.getItem('last_order_id') || sessionStorage.getItem('flashtap_return_order_id') || ''
        ).trim()
      : ''

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
      const { data } = await supabase.from('orders').select('*').eq('id', orderId).single()
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

    const applyOrderUpdate = (updated: Record<string, any>) => {
      if (!updated?.id) return
      if (tableNumber && Number(updated.table_number) !== Number(tableNumber)) return
      if (!isBannerEligibleOrder(updated)) {
        clearActiveOrderBannerState()
        setLastOrder(null)
        setLiveOrder(null)
        return
      }
      const next = { id: String(updated.id), ...updated }
      setLastOrder(next)
      setLiveOrder(next)
      setLastOrderLoaded(true)
    }

    fetchLastOrder().catch(() => {
      if (!cancelled) {
        setLastOrder(null)
        setLastOrderLoaded(true)
      }
    })

    const channel = supabase
      .channel(`menu-tracker-last-order-${orderId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
        (payload: any) => {
          applyOrderUpdate(payload.new as Record<string, any>)
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [restaurantId, tableNumber, persistedOrderId])

  const baseOrder = useMemo(() => {
    if (lastOrder && isBannerEligibleOrder(lastOrder)) return lastOrder
    if (activeOrder && isBannerEligibleOrder(activeOrder)) return activeOrder
    return null
  }, [lastOrder, activeOrder])

  useEffect(() => {
    setLiveOrder(null)
  }, [baseOrder?.id])

  useEffect(() => {
    if (!baseOrder?.id) return

    const orderId = String(baseOrder.id)
    const channel = supabase
      .channel(`order-status-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        (payload: any) => {
          const updated = payload.new as Record<string, any>
          if (!updated?.id) return
          if (tableNumber && Number(updated.table_number) !== Number(tableNumber)) return
          if (!isBannerEligibleOrder(updated)) {
            clearActiveOrderBannerState()
            setLiveOrder(null)
            setLastOrder((prev) => (prev?.id === orderId ? null : prev))
            return
          }
          setLiveOrder({ id: orderId, ...updated })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [baseOrder?.id, tableNumber])

  if (loading && !lastOrderLoaded) return null
  if (error) return null

  const currentOrder =
    liveOrder && baseOrder && String(liveOrder.id) === String(baseOrder.id)
      ? { ...baseOrder, ...liveOrder }
      : baseOrder

  if (!currentOrder) return null

  const steps = buildTrackerSteps(currentOrder)
  const currentIndex = steps.findIndex((step) => !step.complete)
  const activeIndex = currentIndex === -1 ? steps.length - 1 : currentIndex

  const orderNumber = currentOrder.order_number || currentOrder.id.slice(-6).toUpperCase()
  const orderTotal = Number(currentOrder.total) || 0
  const statusLower = String(currentOrder.status || '').toLowerCase()
  const payChannel = String(currentOrder.payment_channel || '').toLowerCase()
  const isPreparing =
    statusLower === 'preparing' || (statusLower === 'accepted' && steps[2].complete && !steps[3].complete)

  const showReadyToPay = statusLower === 'ready' || statusLower === 'accepted'
  const terminalAlreadyNotified =
    statusLower === 'ready_for_terminal' || currentOrder.customer_ready_to_pay === true
  const showTerminalFlow =
    payChannel === 'terminal' &&
    String(currentOrder.payment_status || '').toLowerCase() === 'pending' &&
    statusLower !== 'completed'

  return (
    <section className="border-b border-gray-200 bg-white px-4 py-4">
      <div className="mx-auto max-w-4xl">
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
    </section>
  )
}
