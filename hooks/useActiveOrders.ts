'use client'

import { useEffect, useState } from 'react'
import {
  fetchGuestActiveTableOrders,
  GUEST_ORDER_POLL_MS,
} from '@/lib/guest-orders/client'
import { isActiveOrderStatus } from '@/lib/orders/active-order-visibility'
import { heldSessionIds } from '@/lib/tab-storage'

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
  /** #279: derived server-side. The caller only ever receives rows that are theirs. */
  isMine?: boolean
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
          sessionIds: heldSessionIds(),
        })

        if (cancelled) return

        const placedCutoff = Date.now() - BANNER_ORDER_MAX_AGE_MS
        const activeOrders = (orders || [])
          .map((row) => ({ ...(row as ActiveOrder), id: String(row.id || '') }))
          .filter((order) => Boolean(order.id))
          .filter((order) => {
            const tn = Number(order.table_number)
            if (!Number.isFinite(tn) || tn !== tableNumber) return false
            /**
             * FAIL CLOSED. Absent means not-mine. Ruled 2026-08-17, mechanism changed 2026-08-24.
             *
             * THE RULE IS UNCHANGED: the banner is a PERSONAL surface answering "where is MY food",
             * so "I could not establish this is yours" must resolve to NOT showing it.
             *
             * WHAT CHANGED IS WHO ANSWERS IT. This compared `order.session_id` to our own, which
             * coupled the banner to a field the server had every reason to stop sending. When #279
             * redacted `session_id` out of the response, this failed closed on EVERY row and the
             * banner rendered nothing for anybody. The E2E positive control caught it on the very
             * commit that caused it, and twelve staging deploys shipped over the red anyway.
             *
             * The server now answers ownership directly: `isMine` is derived from the row having
             * matched the caller's own session ids, and a stranger's order is ABSENT rather than
             * flagged. A session id is a capability (#282) and no longer crosses the wire for this.
             *
             * Still fail-closed: a response without `isMine` drops the row rather than showing it.
             */
            if (order.isMine !== true) return false
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
