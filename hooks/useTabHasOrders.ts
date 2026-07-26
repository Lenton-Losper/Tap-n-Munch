'use client'

import { useEffect, useState } from 'react'
import { fetchGuestOrdersBySession, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { getCurrentSession } from '@/lib/session'

/**
 * True when the given tab has at least one line-item order (excludes settlement rows).
 * Uses GET /api/guest/orders/by-session with polling (Stage 2 RLS-safe).
 * Requires the guest session_id — tab UUID alone is never enough.
 */
export function useTabHasOrders(
  restaurantId: string | null | undefined,
  tabId: string | null | undefined
): boolean {
  const rid = String(restaurantId || '').trim()
  const tid = String(tabId || '').trim()
  const [hasOrders, setHasOrders] = useState(false)

  useEffect(() => {
    const sessionId = String(getCurrentSession() || '').trim()
    const enabled = Boolean(rid && tid && sessionId)
    if (!enabled) {
      setHasOrders(false)
      return
    }

    let cancelled = false

    const check = async () => {
      try {
        const { count } = await fetchGuestOrdersBySession({
          restaurantId: rid,
          sessionId,
          tabId: tid,
          countOnly: true,
        })

        if (cancelled) return
        setHasOrders(Number(count || 0) > 0)
      } catch (err) {
        if (cancelled) return
        console.warn('[useTabHasOrders] check failed', err)
        setHasOrders(false)
      }
    }

    void check()
    const interval = window.setInterval(() => {
      void check()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [rid, tid])

  return hasOrders
}
