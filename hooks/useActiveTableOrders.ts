'use client'

import { useEffect, useState } from 'react'
import { getCurrentTableSession } from '@/lib/table-session'
import { fetchGuestOrdersBySession, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { heldSessionIds } from '@/lib/tab-storage'

export interface ActiveTableOrder {
  id: string
  order_number?: number
  status: string
  created_at: any
  total?: number
  table_number?: number
  [key: string]: any
}

/**
 * Hook to get active orders for current table session
 *
 * Data via GET /api/guest/orders/by-session (Stage 1 guest API).
 */
export function useActiveTableOrders(): {
  activeOrders: ActiveTableOrder[]
  loading: boolean
  error: string | null
  total: number
  orderCount: number
} {
  const [activeOrders, setActiveOrders] = useState<ActiveTableOrder[]>([])
  const [loading, setLoading] = useState(() => {
    if (typeof window === 'undefined') return true
    return Boolean(getCurrentTableSession())
  })
  const [error, setError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- table session order fetch guards */
  useEffect(() => {
    const tableSessionId = getCurrentTableSession()

    if (!tableSessionId) {
      return
    }

    const restaurantId = localStorage.getItem('table_session_restaurant')
    if (!restaurantId) {
      setError('Restaurant ID not found')
      setLoading(false)
      return
    }

    let cancelled = false

    const loadOrders = async () => {
      try {
        const { orders } = await fetchGuestOrdersBySession({
          restaurantId,
          sessionId: tableSessionId,
          sessionIds: heldSessionIds(),
        })
        if (cancelled) return

        const filtered = (orders || [])
          .map((row) => ({ ...(row as ActiveTableOrder), id: String(row.id || '') }))
          .filter((order) => Boolean(order.id))
          .filter((order) =>
            ['pending', 'accepted', 'ready'].includes(String(order.status || '').toLowerCase())
          )

        setActiveOrders(filtered)
        setLoading(false)
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load orders')
        setLoading(false)
      }
    }

    void loadOrders()
    const interval = window.setInterval(() => {
      void loadOrders()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const total = activeOrders.reduce((sum, order) => sum + (order.total || 0), 0)
  const orderCount = activeOrders.length

  return { activeOrders, loading, error, total, orderCount }
}
