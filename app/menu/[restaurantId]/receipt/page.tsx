'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

/**
 * STEP 3: Receipt page loads orders using table_session_id
 * 
 * This ensures:
 * - Banner reappears after refresh
 * - Receipt is recoverable
 * - Clearing the tab does NOT lose the order
 */
export default function ReceiptPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''
  
  const [orders, setOrders] = useState<any[]>([])
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadReceipt = async () => {
      // Task 1: Use table_number + is_closed filter instead of session_id
      const tableNum = tableNumber ? Number(tableNumber) : null

      if (!tableNum || tableNum <= 0) {
        console.log('No table number found')
        setLoading(false)
        return
      }

      if (!db) {
        console.error('Firestore not initialized')
        setLoading(false)
        return
      }

      try {
        // Load restaurant data
        if (restaurantId) {
          const restaurantData = await getRestaurant(restaurantId)
          setRestaurant(restaurantData)
        }

        // Task 1: Query orders by table_number and is_closed instead of session_id
        const { ordersPath } = require('@/lib/firebase/paths')
        const ordersRef = collection(db, ordersPath(restaurantId))
        const q = query(
          ordersRef,
          where('table_number', '==', tableNum),
          where('is_closed', '==', false),
          orderBy('placed_at', 'desc')
        )

        const snapshot = await getDocs(q)
        const ordersList = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))

        console.log('📋 Loaded', ordersList.length, 'orders for receipt (table:', tableNum, ')')
        setOrders(ordersList)
        setLoading(false)
      } catch (error: any) {
        console.error('Error loading receipt:', error)
        // Task 3: Handle missing index gracefully
        if (error?.code === 'failed-precondition') {
          console.warn('⚠️ [RECEIPT] Index missing, filtering in memory')
          try {
            const { ordersPath } = require('@/lib/firebase/paths')
            const ordersRef = collection(db, ordersPath(restaurantId))
            const allSnapshot = await getDocs(query(ordersRef, where('table_number', '==', tableNum), limit(50)))
            
            const filteredOrders = allSnapshot.docs
              .map(doc => ({ id: doc.id, ...doc.data() }))
              .filter(order => order.table_number === tableNum && !order.is_closed)
              .sort((a, b) => {
                const aTime = a.placed_at?.toMillis?.() || a.placed_at || 0
                const bTime = b.placed_at?.toMillis?.() || b.placed_at || 0
                return bTime - aTime
              })
            
            setOrders(filteredOrders)
          } catch (fallbackErr) {
            console.error('Fallback query also failed:', fallbackErr)
          }
        }
        setLoading(false)
      }
    }

    loadReceipt()
  }, [restaurantId, tableNumber])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading receipt...</p>
        </div>
      </div>
    )
  }

  // Data safety guard: Check for null/undefined orders array
  if (!orders || !Array.isArray(orders)) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading receipt...</p>
        </div>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="text-6xl mb-4">📋</div>
          <h1 className="text-2xl font-bold mb-2">No Orders Yet</h1>
          <p className="text-gray-600 mb-4">
            You haven't placed any orders in this session.
          </p>
          {restaurantId && (
            <Link href={`/menu/${restaurantId}/browse?table=${tableNumber}`}>
              <Button className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Browse Menu
              </Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

  // Data safety guard: Safe total calculation with null checks
  const total = orders && Array.isArray(orders) 
    ? orders.reduce((sum, order) => sum + (order && typeof order.total === 'number' ? order.total : 0), 0)
    : 0

  return (
    <div className="max-w-4xl mx-auto p-6 min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => router.back()}
            className="text-orange-600 font-semibold flex items-center gap-2"
          >
            ← Back
          </button>
        </div>

        <h1 className="text-3xl font-bold mb-2">Receipt</h1>
        {tableNumber && (
          <p className="text-gray-600">
            Table {tableNumber}
          </p>
        )}

        <div className="mt-4 pt-4 border-t">
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Total Orders:</span>
            <span className="font-bold text-xl">{orders.length}</span>
          </div>
          <div className="flex justify-between items-center mt-2">
            <span className="text-gray-600">Total Amount:</span>
            <span className="font-bold text-2xl text-orange-600">
              {restaurant?.currency || 'N$'}{total.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="space-y-4">
        {orders && Array.isArray(orders) && orders.map((order) => {
          // Data safety guard: Check order exists before accessing properties
          if (!order) return null
          
          // Safe date parsing
          const createdDate = order.created_at?.toDate
            ? order.created_at.toDate()
            : order.created_at
            ? new Date(order.created_at)
            : new Date()

          // Safe total calculation
          const orderTotal = typeof order.total === 'number' ? order.total : 0

          return (
            <div key={order.id || Math.random()} className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">
                    Order #{order.order_number || order.id?.slice(-6)?.toUpperCase() || 'N/A'}
                  </h3>
                  <p className="text-sm text-gray-500">{createdDate?.toLocaleString() || 'N/A'}</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-orange-600">
                    {restaurant?.currency || 'N$'}{orderTotal.toFixed(2)}
                  </p>
                  <span
                    className={`inline-block px-3 py-1 rounded-full text-sm font-semibold mt-2 ${
                      order.status === 'completed'
                        ? 'bg-green-100 text-green-800'
                        : order.status === 'ready'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {order.status || 'unknown'}
                  </span>
                </div>
              </div>

              {/* Order Items */}
              <div className="border-t pt-3">
                {/* Data safety guard: Check items array before mapping */}
                {order.items && Array.isArray(order.items) && order.items.length > 0 ? (
                  <div className="space-y-2">
                    {order.items.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-sm">
                        <span className="text-gray-700">
                          {(item?.quantity || 1)}× {item?.name || 'Unknown Item'}
                        </span>
                        <span className="font-semibold">
                          {restaurant?.currency || 'N$'}{((item?.subtotal || 0)).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">No items found</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Actions */}
      {restaurantId && (
        <div className="mt-6">
          <Link href={`/menu/${restaurantId}/browse?table=${tableNumber}`}>
            <Button className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white py-4 rounded-lg font-semibold text-lg">
              Order More
            </Button>
          </Link>
        </div>
      )}
    </div>
  )
}

