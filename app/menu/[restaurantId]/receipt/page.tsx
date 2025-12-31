'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getCurrentSession } from '@/lib/session'
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
  const sessionInfo = getTableSessionInfo()

  useEffect(() => {
    const loadReceipt = async () => {
      const sessionId = getCurrentSession()

      if (!sessionId) {
        console.log('No session found')
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

        // Query orders for this session
        const ordersRef = collection(db, 'orders')
        const q = query(
          ordersRef,
          where('session_id', '==', sessionId),
          where('restaurant_id', '==', restaurantId),
          orderBy('placed_at', 'desc')
        )

        const snapshot = await getDocs(q)
        const ordersList = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))

        console.log('📋 Loaded', ordersList.length, 'orders for receipt')
        setOrders(ordersList)
        setLoading(false)
      } catch (error: any) {
        console.error('Error loading receipt:', error)
        setLoading(false)
      }
    }

    loadReceipt()
  }, [restaurantId])

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

  const total = orders.reduce((sum, order) => sum + (order.total || 0), 0)

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
        {orders.map((order) => {
          const createdDate = order.created_at?.toDate
            ? order.created_at.toDate()
            : order.created_at
            ? new Date(order.created_at)
            : new Date()

          return (
            <div key={order.id} className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">
                    Order #{order.order_number || order.id.slice(-6).toUpperCase()}
                  </h3>
                  <p className="text-sm text-gray-500">{createdDate.toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-orange-600">
                    {restaurant?.currency || 'N$'}{order.total?.toFixed(2)}
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
                    {order.status}
                  </span>
                </div>
              </div>

              {/* Order Items */}
              <div className="border-t pt-3">
                {Array.isArray(order.items) && order.items.length > 0 ? (
                  <div className="space-y-2">
                    {order.items.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-sm">
                        <span className="text-gray-700">
                          {item.quantity || 1}× {item.name || 'Unknown Item'}
                        </span>
                        <span className="font-semibold">
                          {restaurant?.currency || 'N$'}{(item.subtotal || 0).toFixed(2)}
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

