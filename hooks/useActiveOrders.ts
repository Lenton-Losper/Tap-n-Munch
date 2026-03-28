'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { ordersPath } from '@/lib/firebase/paths'

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
      console.log('🔍 Banner hidden - No table number provided')
      setLoading(false)
      return
    }

    // Cross-Device Query: Use table_number + is_closed (NO session_id filter)
    // This allows ANY device at Table X to see orders, even without a session
    const ordersRef = collection(db, ordersPath(restaurantId))
    
    console.log('🔍 Banner query (Table-Based, cross-device):', {
      restaurantId,
      tableNumber,
      note: 'Querying by table_number + is_closed, filtering status in memory'
    })

    // Query by table_number and is_closed (no session_id required)
    // Filter status in memory to avoid complex index requirements
    const q = query(
      ordersRef,
      where('table_number', '==', tableNumber),
      where('is_closed', '==', false)
    )

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          console.log('📦 Orders found for Table', tableNumber, 'Count:', snapshot.docs.length)
          
          if (snapshot.empty) {
            console.log('🔍 Banner hidden - No active orders found for Table', tableNumber)
            setActiveOrder(null)
            setLoading(false)
            return
          }

          // Filter in memory: status must be active (Table-Based approach)
          // All orders are already filtered by is_closed == false in the query
          const activeOrders = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() } as ActiveOrder))
            .filter(order => {
              const tn = Number(order.table_number)
              if (!Number.isFinite(tn) || tn !== tableNumber) return false
              const statusMatch = ['new', 'accepted', 'preparing', 'ready'].includes(order.status)
              return statusMatch
            })
            .sort((a, b) => {
              // Sort by placed_at descending (most recent first)
              const aTime = a.placed_at?.toMillis?.() || a.placed_at || 0
              const bTime = b.placed_at?.toMillis?.() || b.placed_at || 0
              return bTime - aTime
            })

          if (activeOrders.length === 0) {
            console.log('🔍 Banner hidden - No active orders after status filtering')
            setActiveOrder(null)
            setLoading(false)
            return
          }

          // Get the most recent active order
          const orderData = activeOrders[0]
          
          console.log('✅ Banner showing order (cross-device view):', {
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
        if (err.code === 'permission-denied' || err.message?.includes('permission')) {
          console.warn('⚠️ Permission denied when loading active orders - banner will be hidden')
          setActiveOrder(null)
          setError(null) // Don't show error for permission denied - just hide banner
        } else if (err.code === 'failed-precondition') {
          // Missing index - try fallback query without orderBy
          console.warn('⚠️ Index missing, trying fallback query')
          try {
            const fallbackQuery = query(
              ordersRef,
              where('table_number', '==', tableNumber),
              where('is_closed', '==', false)
            )
            // Note: This will still use the same query, but without orderBy
            // The error might be about the orderBy, so we'll filter in memory
          } catch (fallbackErr) {
            setError('Firestore index not created. Please deploy indexes.')
          }
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
