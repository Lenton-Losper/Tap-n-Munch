'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchGuestActiveTableOrders,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import type { GuestOrderRow } from '@/lib/guest-orders/types'
import { isInProgressOrderStatus } from '@/lib/orders/active-order-visibility'

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

  const getStatusNotification = (
    newStatus: string,
    orderNumber: number,
    oldStatus: string
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
        return {
          id,
          message:
            oldStatus === 'accepted'
              ? `Order #${orderNumber} is being prepared.`
              : `Order #${orderNumber} is ready!`,
          type: oldStatus === 'accepted' ? 'info' : 'success',
          icon: oldStatus === 'accepted' ? '👨‍🍳' : '🍽️',
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
        const newStatus = String(row.status ?? '')
        const newPay = String(row.payment_status ?? '')
        const prev = prevById.get(id)

        if (prev) {
          if (newStatus !== prev.status) {
            const notification = getStatusNotification(newStatus, orderNum, prev.status)
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
        // Derived from ACTIVE_ORDER_STATUSES rather than listed here. The inline copy this
        // replaces had fallen two statuses behind -- `ready_for_terminal` above all, so an
        // order that reached the card machine and was then paid and closed said nothing.
        //
        // The `prev.status !== 'completed'` clause that used to guard this is gone: `completed`
        // is a TERMINAL_ORDER_STATUS and can never be in the derived set, so it excluded
        // nothing while implying the set might contain it.
        //
        // AND it must have been PAID. A disappearance is not evidence of completion: the guest
        // poll filters on is_closed with no status filter (lib/guest-orders/queries.ts:204-213),
        // and the dashboard cancel writes is_closed=true together with
        // payment_status='cancelled' in a single patch (app/api/orders/[orderId]/status/route.ts
        // :92-94). So a cancelled order leaves the poll in the very write that cancels it -- the
        // status seen here is whatever preceded the cancel, and without this check the customer
        // is told "completed. Enjoy your meal!" about an order that was just cancelled.
        //
        // The last observed payment_status is what separates the two, and the banner already
        // holds it, so this costs no extra request. A genuine close-out was settled first and
        // detached later by the table close (app/api/tables/[tableNumber]/close/route.ts:95),
        // so the poll saw 'paid'; a cancel never presents 'paid' because it is atomic with the
        // removal.
        if (isInProgressOrderStatus(prev.status) && normalizePaid(prev.payment_status)) {
          const notification = getStatusNotification('completed', prev.order_number, prev.status)
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
