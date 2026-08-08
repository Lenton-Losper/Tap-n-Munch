'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchGuestActiveTableOrders,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import type { GuestOrderRow } from '@/lib/guest-orders/types'
import { normalizeOrderStatusForDisplay } from '@/lib/orders/active-order-visibility'

interface Notification {
  id: string
  message: string
  type: 'success' | 'info' | 'warning'
  icon: string
}

interface OrderStatusBannerProps {
  restaurantId: string
  tableNumber: number
}

type OrderSnapshot = {
  status: string
  payment_status: string
  order_number: number
}

function normalizePaid(value: unknown): boolean {
  return String(value ?? '').toLowerCase() === 'paid'
}

function orderNumberFromRow(row: GuestOrderRow): number {
  if (typeof row.order_number === 'number') return row.order_number
  return Number(row.order_number) || 0
}

export default function OrderStatusBanner({ restaurantId, tableNumber }: OrderStatusBannerProps) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prevByIdRef = useRef<Map<string, OrderSnapshot>>(new Map())

  const addNotification = useCallback((notification: Notification) => {
    setNotifications((prev) => [...prev, notification])
    const t = setTimeout(() => {
      dismissTimersRef.current.delete(notification.id)
      setNotifications((prev) => prev.filter((n) => n.id !== notification.id))
    }, 5000)
    dismissTimersRef.current.set(notification.id, t)
  }, [])

  useEffect(() => {
    return () => {
      // Read ref at unmount so all timers (including ones registered after mount) are cleared.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- ref must be read at cleanup time, not captured at mount
      for (const t of dismissTimersRef.current.values()) clearTimeout(t)
      dismissTimersRef.current.clear()
    }
  }, [])

  /**
   * `status` here is always already through normalizeOrderStatusForDisplay -- see applyOrderDiff.
   * This switch must never re-decide which words mean which state; that is what produced #173.
   */
  const getStatusNotification = (
    newStatus: string,
    orderNumber: number
  ): Notification | null => {
    const id = `${orderNumber}-${newStatus}-${Date.now()}`

    switch (newStatus) {
      case 'accepted':
        return {
          id,
          message: `Order #${orderNumber} has been accepted! We're getting started.`,
          type: 'success',
          icon: '✅',
        }
      case 'ready':
        // Unconditionally "ready". This previously said "is being prepared" when the previous
        // status was `accepted`, telling the customer their finished order was not finished --
        // the same defect #131 fixed in the receipt badge mapper. A transition INTO `ready`
        // means ready, whatever the order was doing a moment ago.
        return {
          id,
          message: `Order #${orderNumber} is ready!`,
          type: 'success',
          icon: '🍽️',
        }
      case 'completed':
        return {
          id,
          message: `Order #${orderNumber} completed. Enjoy your meal!`,
          type: 'success',
          icon: '🎉',
        }
      case 'declined':
        return {
          id,
          message: `Order #${orderNumber} was declined. Please speak to a staff member.`,
          type: 'warning',
          icon: '⚠️',
        }
      default:
        return null
    }
  }

  const applyOrderDiff = useCallback(
    (orders: GuestOrderRow[]) => {
      const prevById = prevByIdRef.current
      const currentIds = new Set<string>()

      for (const row of orders) {
        const id = String(row.id || '').trim()
        if (!id) continue
        if (Number(row.table_number) !== Number(tableNumber)) continue

        currentIds.add(id)
        const orderNum = orderNumberFromRow(row)
        // Normalised at ingestion, so every comparison and every message below is in one
        // vocabulary. `confirmed` is the terminal's word for `accepted`, and without this the
        // first thing a staff member does on the terminal told the customer nothing while the
        // identical dashboard action announced itself (#173, same root cause as #131).
        //
        // Safe to normalise wholesale here in a way it was NOT in menu-order-status-tracker:
        // this component renders transient notifications only. It gates no control, so nothing
        // a customer can act on changes as a result.
        const newStatus = normalizeOrderStatusForDisplay(row.status)
        const newPay = String(row.payment_status ?? '')
        const prev = prevById.get(id)

        if (prev) {
          if (newStatus !== prev.status) {
            const notification = getStatusNotification(newStatus, orderNum)
            if (notification) {
              addNotification(notification)
              if ('vibrate' in navigator) {
                navigator.vibrate([200, 100, 200])
              }
            }
          }

          if (newPay !== prev.payment_status) {
            if (normalizePaid(newPay) && !normalizePaid(prev.payment_status)) {
              addNotification({
                id: `${orderNum}-paid-${Date.now()}`,
                message: `Payment confirmed for Order #${orderNum} ✓`,
                type: 'success',
                icon: '💳',
              })
            }
          }
        }

        prevById.set(id, {
          status: newStatus,
          payment_status: newPay,
          order_number: orderNum,
        })
      }

      for (const [id, prev] of prevById.entries()) {
        if (currentIds.has(id)) continue
        // prev.status is normalised, so a terminal-confirmed order reaches this list as
        // `accepted` and gets the same disappearance notification the dashboard flow gets.
        const wasInProgress = ['accepted', 'preparing', 'ready', 'pending'].includes(prev.status)
        if (wasInProgress && prev.status !== 'completed') {
          const notification = getStatusNotification('completed', prev.order_number)
          if (notification) addNotification(notification)
        }
        prevById.delete(id)
      }
    },
    [tableNumber, addNotification]
  )

  useEffect(() => {
    if (!restaurantId || tableNumber <= 0) return

    let cancelled = false
    prevByIdRef.current = new Map()

    const tick = async () => {
      try {
        const { orders } = await fetchGuestActiveTableOrders({
          restaurantId,
          tableNumber,
        })
        if (cancelled) return
        applyOrderDiff(orders || [])
      } catch (error) {
        console.error('[OrderStatusBanner] poll failed', error)
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      void tick()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [restaurantId, tableNumber, applyOrderDiff])

  if (notifications.length === 0) return null

  return (
    <div
      className="fixed top-4 left-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className={`
            flex items-center gap-3 px-4 py-3 rounded-2xl shadow-lg
            pointer-events-auto animate-slide-down
            ${
              notification.type === 'success'
                ? 'bg-green-500 text-white'
                : notification.type === 'warning'
                  ? 'bg-yellow-500 text-white'
                  : 'bg-gray-900 text-white'
            }
          `}
        >
          <span className="text-2xl">{notification.icon}</span>
          <p className="text-sm font-medium flex-1">{notification.message}</p>
          <button
            type="button"
            onClick={() => {
              const t = dismissTimersRef.current.get(notification.id)
              if (t) clearTimeout(t)
              dismissTimersRef.current.delete(notification.id)
              setNotifications((prev) => prev.filter((n) => n.id !== notification.id))
            }}
            className="text-white/70 hover:text-white text-lg leading-none"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
