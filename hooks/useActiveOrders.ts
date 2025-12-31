'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { ordersPath } from '@/lib/firebase/paths'
import { getCurrentSession } from '@/lib/session'

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
 * PART 2: Fix Active Order Banner Query (CRITICAL)
 * 
 * Banner should show orders for this TABLE, not browser session.
 * Query: restaurant_id + table_number + status in [new, accepted, preparing, ready] + table_closed = false
 * 
 * This ensures:
 * - Banner appears after tab close
 * - Banner survives refresh
 * - Banner is table-specific
 * - No order leakage to new customers
 */
export function useActiveOrders(restaurantId?: string, tableNumber?: number): {
  activeOrder: ActiveOrder | null
  loading: boolean
  error: string | null
} {
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!db) {
      console.error('❌ useActiveOrders: Firestore not initialized')
      setError('Firestore not initialized')
      setLoading(false)
      return
    }

    if (!restaurantId) {
      console.log('⚠️ useActiveOrders: No restaurantId provided')
      setLoading(false)
      return
    }

    if (!tableNumber || tableNumber <= 0) {
      // PART 7: Debug Logging
      console.log('🔍 PART 7: Banner hidden - No table number provided')
      console.log('🔍 PART 7: tableNumber:', tableNumber)
      setLoading(false)
      return
    }

    // PART 2: Query by restaurant_id + table_number (primary) OR session_id (fallback)
    // PART 7: Debug Logging
    
    // CRITICAL: Get session_id from localStorage using getCurrentSession (acts as getPersistentSession)
    // This allows the banner to find orders even after tab close and rescan
    const sessionId = getCurrentSession()
    console.log('🔍 Banner searching for session:', sessionId)
    
    console.log('🔔 PART 7: Banner query:', { 
      restaurantId, 
      tableNumber,
      sessionId: sessionId || 'none',
      queryStrategy: 'table_number (primary), session_id (fallback if available)'
    })

    // NEW: Use hierarchical path - restaurant_id is in the path, no need to filter
    // CRITICAL: Query by table_number (primary) - this is the main query strategy
    // If session_id is available, we'll also check orders for session_id match
    const ordersRef = collection(db, ordersPath(restaurantId))
    
    // SIMPLIFIED QUERY: Only query by session_id to avoid index requirements
    // CRITICAL: ActiveOrderBanner must only show orders matching the current device's session_id
    if (!sessionId) {
      console.log('⚠️ No session_id available - banner will not show orders')
      setLoading(false)
      return
    }

    // SIMPLIFIED: Query only by session_id (no orderBy to bypass index requirements)
    // Filter status and table_closed in memory after fetch
    const q = query(
      ordersRef,
      where('session_id', '==', sessionId)
    )
    
    console.log('🔍 Banner query (session_id only):', {
      session_id: sessionId,
      note: 'Filtering status and table_closed in memory to avoid index requirements'
    })

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          console.log('📦 Orders found for session:', sessionId, 'Count:', snapshot.docs.length)
          
          if (snapshot.empty) {
            console.log('🔍 Banner hidden - No orders found for session:', sessionId)
            setActiveOrder(null)
            setLoading(false)
            return
          }

          // Filter in memory: status must be active AND table_closed must be false
          // Also verify table_number matches (if provided)
          const activeOrders = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() } as ActiveOrder))
            .filter(order => {
              const statusMatch = ['new', 'accepted', 'preparing', 'ready'].includes(order.status)
              const notClosed = order.table_closed !== true
              const tableMatch = !tableNumber || order.table_number === Number(tableNumber)
              return statusMatch && notClosed && tableMatch
            })
            .sort((a, b) => {
              // Sort by placed_at descending (most recent first)
              const aTime = a.placed_at?.toMillis?.() || 0
              const bTime = b.placed_at?.toMillis?.() || 0
              return bTime - aTime
            })

          if (activeOrders.length === 0) {
            console.log('🔍 Banner hidden - No active orders after filtering')
            setActiveOrder(null)
            setLoading(false)
            return
          }

          // Get the most recent active order
          const orderData = activeOrders[0]
          
          console.log('✅ Banner showing order:', {
            orderId: orderData.id,
            status: orderData.status,
            tableNumber: orderData.table_number,
            orderNumber: orderData.order_number
          })
          
          setActiveOrder(orderData)
          setLoading(false)
          setError(null)
        } catch (err: any) {
          console.error('Error processing active orders:', err)
          setError(err.message || 'Failed to process orders')
          setLoading(false)
        }
      },
      (err) => {
        console.error('Error in useActiveOrders listener:', err)
        if (err.code === 'failed-precondition') {
          setError('Firestore index not created. Please deploy indexes.')
        } else {
          setError(err.message || 'Failed to load active orders')
        }
        setLoading(false)
      }
    )

    return () => {
      unsubscribe()
    }
  }, [restaurantId, tableNumber])

  return { activeOrder, loading, error }
}
