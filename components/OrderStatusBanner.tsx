'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchGuestActiveTableOrders,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import type { GuestOrderRow } from '@/lib/guest-orders/types'
import { customerOrderState } from '@/lib/orders/customer-status'
import { hasAllocatedOrderNumber } from '@/lib/orders/order-identity'
import { heldSessionIds } from '@/lib/tab-storage'

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
  /** What to print after "Order #": the allocated number, or the short id when there is none. */
  orderLabel: string
}

function normalizePaid(value: unknown): boolean {
  return String(value ?? '').toLowerCase() === 'paid'
}

/**
 * WHAT TO CALL THIS ORDER IN A NOTIFICATION. Found by scripts/check-order-number-guard.ts on
 * 2026-08-19, not by hand -- this was a live "Order #0" the eye had missed.
 *
 * It returned `Number(row.order_number) || 0`, so a row with no allocated number produced 0 and
 * the customer was told "Order #0 has been accepted!". The guest-order mapper was handing every
 * order_request a literal `order_number: 0`, which is now null at source.
 *
 * NO NEW COPY IS INVENTED. When there is no number the short id is used instead, which is exactly
 * what app/order-confirmation/page.tsx already does for the same situation
 * (`o.id.slice(-8).toUpperCase()`). The customer gets an identifier that is real and that they can
 * show a staff member, rather than one that is neither.
 *
 * Returns the string that goes after "Order #", so the call sites do not each decide.
 */
function orderLabelFromRow(row: GuestOrderRow): string {
  if (hasAllocatedOrderNumber({ order_number: row.order_number })) {
    return String(Number(row.order_number))
  }
  const id = String(row.id ?? '')
  return id ? id.slice(-8).toUpperCase() : '—'
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
   * WHAT A STATUS CHANGE TELLS THE CUSTOMER (#173).
   *
   * TWO DEFECTS, both live on production, both from the same cause — a private status map:
   *
   *   1. A READY ORDER WAS TOLD IT WAS BEING PREPARED. The `ready` arm read
   *
   *        oldStatus === 'accepted' ? `Order #N is being prepared.` : `Order #N is ready!`
   *
   *      so an order moving accepted -> ready — which is what happens whenever the kitchen does
   *      not set an explicit `preparing` step — announced the LESS advanced state. The customer
   *      was told their food was being cooked at the moment the restaurant said it was done, and
   *      the icon and severity were downgraded to match.
   *
   *   2. A TERMINAL-CONFIRMED ORDER NOTIFIED NOTHING. The terminal writes `confirmed` where the
   *      dashboard writes `accepted`. `confirmed` was not a case, so it fell through to
   *      `default: null` and the customer heard nothing at all.
   *
   * `customerOrderState` normalises (`confirmed` -> `accepted`, `accepting` -> `waiting_review`)
   * and answers in the six customer states, so this site cannot disagree with My Orders or the
   * Tab about what an order is doing. It also brings `preparing` — which this switch never had a
   * case for — and `paid`, which beats any kitchen status.
   *
   * `oldStatus` is no longer consulted, and that is the fix rather than a tidy-up: what to tell
   * someone depends on where the order IS, not on where it was, and reading the previous state is
   * exactly what produced defect 1.
   */
  const getStatusNotification = (
    newStatus: string,
    orderNumber: string,
    _oldStatus: string,
    paymentStatus?: string
  ): Notification | null => {
    const id = `${orderNumber}-${newStatus}-${Date.now()}`

    switch (customerOrderState({ status: newStatus, paymentStatus })) {
      case 'accepted':
        return {
          id,
          message: `Order #${orderNumber} has been accepted! We're getting started.`,
          type: 'success',
          icon: '✅',
        }
      case 'preparing':
        return {
          id,
          message: `Order #${orderNumber} is being prepared.`,
          type: 'info',
          icon: '👨‍🍳',
        }
      case 'ready':
        return {
          id,
          message: `Order #${orderNumber} is ready!`,
          type: 'success',
          icon: '🍽️',
        }
      case 'paid':
        return {
          id,
          message: `Order #${orderNumber} completed. Enjoy your meal!`,
          type: 'success',
          icon: '🎉',
        }
      /**
       * THE FOUR THAT REPLACED `needs_you`. It announced "needs your attention. Please speak to a
       * staff member" for all of them — which is the app refusing to say what happened when it
       * knows. Each now says its own thing, and only the payment failure asks anything of anyone.
       */
      case 'declined':
        return {
          id,
          message: `Order #${orderNumber} was not accepted by the restaurant.`,
          type: 'warning',
          icon: '🚫',
        }
      case 'cancelled':
        return {
          id,
          message: `Order #${orderNumber} was cancelled.`,
          type: 'warning',
          icon: '🚫',
        }
      /**
       * Deliberately SILENT, like `waiting`. An order sitting at the terminal is a normal step
       * the customer did not initiate and cannot speed up; a banner for it is noise, and this
       * component exists to announce that something changed for the better.
       */
      case 'awaiting_payment':
        return null
      case 'payment_failed':
        return {
          id,
          message: `Order #${orderNumber}: the payment did not go through. Please speak to a staff member.`,
          type: 'warning',
          icon: '⚠️',
        }
      /**
       * `waiting` and `unknown` say nothing, deliberately. A banner exists to announce that
       * something changed for the better; "still waiting" is not news, and an unknown status is
       * not something to make a claim about.
       */
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
        const orderNum = orderLabelFromRow(row)
        const newStatus = String(row.status ?? '')
        const newPay = String(row.payment_status ?? '')
        const prev = prevById.get(id)

        if (prev) {
          if (newStatus !== prev.status) {
            // `newPay` is passed so a settled order says "paid" rather than whatever the kitchen
            // status happens to be: markOrderPaidConfirmed writes `completed` from ANY status,
            // and the terminal can settle an order the kitchen is still working on.
            const notification = getStatusNotification(newStatus, orderNum, prev.status, newPay)
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
          orderLabel: orderNum,
        })
      }

      for (const [id, prev] of prevById.entries()) {
        if (currentIds.has(id)) continue
        const wasInProgress = ['accepted', 'preparing', 'ready', 'pending'].includes(prev.status)
        if (wasInProgress && prev.status !== 'completed') {
          /**
           * DELIBERATELY NOT ROUTED THROUGH `getStatusNotification`.
           *
           * This arm fires when an in-progress order DISAPPEARS from the customer's list, and it
           * infers completion from the disappearance. That inference predates #173 and is out of
           * its scope — but feeding a synthetic `'completed'` through the status vocabulary would
           * change it: `completed` without a paid payment_status maps to `ready`, deliberately
           * (#234 — reconcile can complete an order with no payment), so a vanished unpaid order
           * would start announcing "is ready!".
           *
           * Keeping the message here preserves the existing behaviour exactly, and keeps #173's
           * change to the defect it is about.
           */
          addNotification({
            id: `${prev.orderLabel}-vanished-${Date.now()}`,
            message: `Order #${prev.orderLabel} completed. Enjoy your meal!`,
            type: 'success',
            icon: '🎉',
          })
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
        /**
         * #279 REGRESSION FIX. This called the endpoint with NO session scope. Once the route
         * began requiring one, the client short-circuited before issuing any request at all and
         * this banner went permanently inert -- no status-change notification ever fired again.
         *
         * The browser already holds these ids; they simply were not being sent. Scoping is right
         * on its own terms too: a status notification is personal, and this diffed EVERY order
         * at the table.
         */
        const { orders } = await fetchGuestActiveTableOrders({
          restaurantId,
          tableNumber,
          sessionIds: heldSessionIds(),
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
