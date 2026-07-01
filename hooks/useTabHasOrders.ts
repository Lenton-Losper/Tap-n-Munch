'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

/**
 * True when the given tab has at least one line-item order (excludes settlement rows).
 * Subscribes to Supabase Realtime so the UI updates after the first order is placed.
 */
export function useTabHasOrders(
  restaurantId: string | null | undefined,
  tabId: string | null | undefined
): boolean {
  const rid = String(restaurantId || '').trim()
  const tid = String(tabId || '').trim()
  const enabled = Boolean(rid && tid)
  const [hasOrders, setHasOrders] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    const check = async () => {
      const { count, error } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', rid)
        .eq('tab_id', tid)
        .is('tab_settlement_for_tab_id', null)
        .not('status', 'in', '("cancelled")')

      if (cancelled) return

      if (error) {
        console.warn('[useTabHasOrders] check failed', error)
        setHasOrders(false)
        return
      }

      setHasOrders(Number(count || 0) > 0)
    }

    void check()

    const channel = supabase
      .channel(`tab-has-orders-${rid}-${tid}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `tab_id=eq.${tid}` },
        () => {
          void check()
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [enabled, rid, tid])

  return enabled ? hasOrders : false
}
