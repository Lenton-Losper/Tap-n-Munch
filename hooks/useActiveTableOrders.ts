'use client'

import { useEffect, useState } from 'react'
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getCurrentTableSession, validateTableSession } from '@/lib/table-session'
import { ordersPath } from '@/lib/firebase/paths'

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // STEP 6: Safety Guards
    // Get table session ID from localStorage
    const tableSessionId = getCurrentTableSession()

    if (!tableSessionId) {
      console.log('📭 No table session ID in localStorage')
      setLoading(false)
      return
    }

    if (!db) {
      console.error('❌ Firestore not initialized')
      setError('Firestore not initialized')
      setLoading(false)
      return
    }

    // STEP 6: Safety guard - If localStorage.table_session_id exists but session is CLOSED → clear it
    validateTableSession(tableSessionId).then((isValid) => {
      if (!isValid) {
        console.log('⚠️ Table session is not active or closed')
        setActiveOrders([])
        setLoading(false)
        return
      }

      console.log('🔍 Querying orders for table_session_id:', tableSessionId)

      // NOTE: This hook queries by session_id, but with hierarchical structure,
      // we need restaurantId. For now, we'll need to get it from localStorage or params.
      // TODO: Update this hook to use table_number instead of session_id
      // For now, we'll try to get restaurantId from localStorage
      const restaurantId = localStorage.getItem('table_session_restaurant')
      if (!restaurantId) {
        console.error('❌ No restaurant ID found in localStorage')
        setError('Restaurant ID not found')
        setLoading(false)
        return
      }

      // Query orders for this table session
      // Status in ['pending', 'accepted', 'preparing', 'ready'] means active orders
      // NEW: Use hierarchical path
      const ordersRef = collection(db, ordersPath(restaurantId))
      const q = query(
        ordersRef,
        where('session_id', '==', tableSessionId),
        where('status', 'in', ['pending', 'accepted', 'preparing', 'ready']),
        orderBy('created_at', 'desc')
      )

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          try {
            const orders = snapshot.docs.map((doc) => ({
              id: doc.id,
              ...doc.data(),
            })) as ActiveTableOrder[]

            console.log('📦 Active orders found:', orders.length)

            // STEP 6: Safety guard - If banner finds 0 orders → hide gracefully (no crashes)
            setActiveOrders(orders)
            setLoading(false)
            setError(null)
          } catch (err: any) {
            console.error('Error processing orders:', err)
            setError(err.message || 'Failed to process orders')
            setLoading(false)
          }
        },
        (err) => {
          console.error('Error in useActiveTableOrders listener:', err)
          if (err.code === 'failed-precondition') {
            setError('Firestore index not created. Please deploy indexes.')
          } else {
            setError(err.message || 'Failed to load orders')
          }
          setLoading(false)
        }
      )

      return () => {
        unsubscribe()
      }
    })
  }, [])

  const total = activeOrders.reduce((sum, order) => sum + (order.total || 0), 0)
  const orderCount = activeOrders.length

  return { activeOrders, loading, error, total, orderCount }
}

