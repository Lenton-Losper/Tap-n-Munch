'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'

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

type OrderRow = {
  table_number?: unknown
  status?: unknown
  order_number?: unknown
  payment_status?: unknown
}

function normalizePaid(value: unknown): boolean {
  return String(value ?? '').toLowerCase() === 'paid'
}

export default function OrderStatusBanner({ restaurantId, tableNumber }: OrderStatusBannerProps) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

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

  useEffect(() => {
    if (!restaurantId || tableNumber <= 0) return

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return

    const supabase = createBrowserClient(url, key)

    const channel = supabase
      .channel(`customer-notifications-${restaurantId}-table-${tableNumber}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        (payload) => {
          const newOrder = payload.new as OrderRow
          const oldOrder = payload.old as OrderRow

          if (Number(newOrder.table_number) !== Number(tableNumber)) return

          const orderNum =
            typeof newOrder.order_number === 'number'
              ? newOrder.order_number
              : Number(newOrder.order_number) || 0

          const oldStatus = String(oldOrder?.status ?? '')
          const newStatus = String(newOrder.status ?? '')

          if (newStatus !== oldStatus) {
            const notification = getStatusNotification(newStatus, orderNum, oldStatus)
            if (notification) {
              addNotification(notification)
              if ('vibrate' in navigator) {
                navigator.vibrate([200, 100, 200])
              }
            }
          }

          const oldPay = oldOrder?.payment_status
          const newPay = newOrder.payment_status
          if (String(newPay ?? '') !== String(oldPay ?? '')) {
            if (normalizePaid(newPay) && !normalizePaid(oldPay)) {
              addNotification({
                id: `${orderNum}-paid-${Date.now()}`,
                message: `Payment confirmed for Order #${orderNum} ✓`,
                type: 'success',
                icon: '💳',
              })
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [restaurantId, tableNumber, addNotification])

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
