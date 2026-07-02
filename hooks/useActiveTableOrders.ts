'use client'

import { useEffect, useState } from 'react'
import { getCurrentTableSession } from '@/lib/table-session'
import { supabase } from '@/lib/supabase/client'

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
 * Banner logic (CRITICAL):
 * - Banner appears if localStorage.table_session_id EXISTS
 * - AND there are orders with table_session_id == localStorage.table_session_id
 * - AND status != "completed"
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

    const loadOrders = async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('session_id', tableSessionId)
        .in('status', ['pending', 'accepted', 'ready'])
        .order('created_at', { ascending: false })
      if (error) {
        setError(error.message || 'Failed to load orders')
        setLoading(false)
        return
      }
      setActiveOrders((data || []) as ActiveTableOrder[])
      setLoading(false)
      setError(null)
    }

    void loadOrders()
    const channel = supabase
      .channel(`active-table-orders-${restaurantId}-${tableSessionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `session_id=eq.${tableSessionId}` },
        () => void loadOrders()
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const total = activeOrders.reduce((sum, order) => sum + (order.total || 0), 0)
  const orderCount = activeOrders.length

  return { activeOrders, loading, error, total, orderCount }
}
