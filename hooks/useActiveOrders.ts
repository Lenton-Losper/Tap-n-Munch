'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

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
 * Cross-Device Active Order Banner Hook (Table-Based)
 * 
 * Banner shows orders for this TABLE, not browser session.
 * Query: restaurant_id + table_number + is_closed == false + status in [new, accepted, preparing, ready]
 * 
 * This ensures:
 * - Cross-device visibility: Any device at Table X sees all orders for that table
 * - Banner appears after tab close and refresh
 * - Banner is table-specific
 * - Works for anonymous users (no session required)
 * - Privacy: Orders hidden once table is closed (is_closed == true)
 */
export function useActiveOrders(
  restaurantId?: string,
  tableNumber?: number,
  isKiosk?: boolean,
  customerName?: string
): {
  activeOrder: ActiveOrder | null
  loading: boolean
  error: string | null
} {
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setActiveOrder(null)
    setError(null)

    if (!restaurantId) {
      console.log('⚠️ useActiveOrders: No restaurantId provided')
      setLoading(false)
      return
    }

    if (!tableNumber || tableNumber <= 0) {
      console.log('🔍 Banner hidden - No table number provided')
      setActiveOrder(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false

    const fetchOrders = async () => {
      try {
        let query = supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', restaurantId)
          .eq('table_number', Number(tableNumber))
          .eq('is_closed', false)

        // TODO: Replace customer_name filtering with kiosk_session_id when
        // shared-device session model is implemented. See mentor brief 29/06/2026.
        if (isKiosk && customerName) {
          query = query.eq('channel', 'kiosk').eq('customer_name', customerName)
        }

        const { data: orders, error: queryError } = await query

        if (queryError) throw queryError
        if (cancelled) return

        const placedCutoff = Date.now() - BANNER_ORDER_MAX_AGE_MS
        const activeOrders = (orders || [])
          .map((row: any) => ({ ...(row as ActiveOrder), id: String((row as { id?: string }).id || '') }))
          .filter((order: any) => Boolean(order.id))
          .filter((order: any) => {
            const tn = Number(order.table_number)
            if (!Number.isFinite(tn) || tn !== tableNumber) return false
            const placedMs = orderPlacedAtMs(order)
            if (!placedMs || placedMs < placedCutoff) return false
            return ['pending', 'accepted', 'ready', 'ready_for_terminal'].includes(
              String(order.status || '').toLowerCase()
            )
          })
          .sort((a: any, b: any) => orderPlacedAtMs(b) - orderPlacedAtMs(a))

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

    fetchOrders()

    const channel = supabase
      .channel(`active-orders-${restaurantId}-${tableNumber}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => {
          fetchOrders().catch(() => {
            // no-op: handled in fetchOrders
          })
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [restaurantId, tableNumber, isKiosk, customerName])

  return { activeOrder, loading, error }
}
