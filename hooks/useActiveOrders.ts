'use client'

import { useEffect, useState } from 'react'
import {
  fetchGuestActiveTableOrders,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import { isActiveOrderStatus } from '@/lib/orders/active-order-visibility'

/** Ignore banner orders older than this (stale visits / previous days). */
const BANNER_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000

function orderPlacedAtMs(order: ActiveOrder): number {
  const p = order.placed_at
  if (p && typeof p.toMillis === 'function') return p.toMillis()
  if (typeof p === 'number' && Number.isFinite(p)) return p
  if (typeof p === 'string') {
    const d = new Date(p)
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  if (p && typeof p === 'object' && 'seconds' in p) {
    const sec = Number((p as { seconds: number }).seconds)
    if (Number.isFinite(sec)) return sec * 1000
  }
  return 0
}

export interface ActiveOrder {
  id: string
  order_number?: number
  status: string
  placed_at: any
  total?: number
  table_number?: number
  restaurant_id?: string
  session_id?: string
  [key: string]: any
}

/**
 * Cross-Device Active Order Banner Hook
 *
 * Always scopes by session_id when provided (table + kiosk). Without a session id,
 * returns no active order rather than leaking another customer's table-wide order.
 */
export function useActiveOrders(
  restaurantId?: string,
  tableNumber?: number,
  isKiosk?: boolean,
  customerName?: string,
  sessionId?: string
): {
  activeOrder: ActiveOrder | null
  loading: boolean
  error: string | null
} {
  const queryKey = `${restaurantId ?? ''}|${tableNumber ?? ''}|${isKiosk ? '1' : '0'}|${sessionId ?? ''}`
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snapshotKey, setSnapshotKey] = useState(queryKey)
  if (snapshotKey !== queryKey) {
    setSnapshotKey(queryKey)
    setActiveOrder(null)
    setError(null)
    setLoading(true)
  }

  /* eslint-disable react-hooks/set-state-in-effect -- active-order fetch lifecycle guards */
  useEffect(() => {
    if (!restaurantId) {
      console.log('⚠️ useActiveOrders: No restaurantId provided')
      setLoading(false)
      return
    }

    if (!tableNumber || tableNumber <= 0) {
      console.log('🔍 Banner hidden - No table number provided')
      setLoading(false)
      return
    }

    const scopedSessionId = String(sessionId || '').trim()
    if (!scopedSessionId) {
      // Fail closed: never show table-wide orders without a session scope.
      setActiveOrder(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false

    const fetchOrders = async () => {
      try {
        const { orders } = await fetchGuestActiveTableOrders({
          restaurantId,
          tableNumber: Number(tableNumber),
          sessionId: scopedSessionId,
        })

        if (cancelled) return

        const placedCutoff = Date.now() - BANNER_ORDER_MAX_AGE_MS
        const activeOrders = (orders || [])
          .map((row) => ({ ...(row as ActiveOrder), id: String(row.id || '') }))
          .filter((order) => Boolean(order.id))
          .filter((order) => {
            const tn = Number(order.table_number)
            if (!Number.isFinite(tn) || tn !== tableNumber) return false
            const orderSession = String(order.session_id || '').trim()
            if (orderSession && orderSession !== scopedSessionId) return false
            const placedMs = orderPlacedAtMs(order)
            if (!placedMs || placedMs < placedCutoff) return false
            return isActiveOrderStatus(order.status)
          })
          .sort((a, b) => orderPlacedAtMs(b) - orderPlacedAtMs(a))

        setActiveOrder(activeOrders[0] || null)
        setLoading(false)
        setError(null)
      } catch (err: any) {
        if (cancelled) return
        setError(err?.message || 'Failed to load active orders')
        setActiveOrder(null)
        setLoading(false)
      }
    }

    void fetchOrders()
    const interval = window.setInterval(() => {
      void fetchOrders()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [restaurantId, tableNumber, isKiosk, customerName, sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  return { activeOrder, loading, error }
}
