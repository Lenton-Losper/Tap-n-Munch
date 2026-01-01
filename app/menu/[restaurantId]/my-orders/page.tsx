'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getCurrentSession, clearSession, getSessionInfo } from '@/lib/session'

export default function MyOrdersPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const sessionId = getCurrentSession()
  const sessionInfo = getSessionInfo()

  useEffect(() => {
    if (!sessionId) {
      alert('No active session. Please scan the QR code to start ordering.')
      router.push(`/menu/${restaurantId}?table=${tableNumber}`)
      return
    }

    if (!db) {
      setLoading(false)
      return
    }

    // Real-time listener for all orders in this session
    const ordersRef = collection(db, 'orders')
    const q = query(
      ordersRef,
      where('session_id', '==', sessionId),
      orderBy('placed_at', 'desc')
    )

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const ordersList = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
        setOrders(ordersList)
        setLoading(false)
        console.log('Loaded orders for session:', sessionId, ordersList.length)
      },
      (error) => {
        console.error('Error loading orders:', error)
        // If index doesn't exist yet, show empty state
        if (error.code === 'failed-precondition') {
          console.warn('Firestore index not created yet. Please create the index for session_id queries.')
        }
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [sessionId, restaurantId, tableNumber, router])

  const handleEndSession = () => {
    if (
      confirm(
        'Are you sure you want to end your session? This will clear all your orders from this device.'
      )
    ) {
      clearSession()
      alert('Session ended. Thank you!')
      // Task 2: Redirect to menu page instead of root
      router.push(`/menu/${restaurantId}/v2?table=${tableNumber}`)
    }
  }

  const getStatusConfig = (status: string) => {
    const configs: any = {
      new: { emoji: '🎉', label: 'New', color: 'bg-blue-100 text-blue-800' },
      accepted: { emoji: '👨‍🍳', label: 'Accepted', color: 'bg-purple-100 text-purple-800' },
      preparing: { emoji: '🔥', label: 'Preparing', color: 'bg-orange-100 text-orange-800' },
      ready: { emoji: '✅', label: 'Ready', color: 'bg-green-100 text-green-800' },
      completed: { emoji: '✨', label: 'Completed', color: 'bg-gray-100 text-gray-800' },
    }
    return configs[status] || configs.new
  }

  const getTotalSpent = () => {
    return orders.reduce((sum, order) => sum + (order.total || 0), 0)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your orders...</p>
        </div>
      </div>
    )
  }

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
          <button
            onClick={handleEndSession}
            className="text-red-600 font-semibold text-sm"
          >
            End Session
          </button>
        </div>

        <h1 className="text-3xl font-bold mb-2">My Orders</h1>
        <p className="text-gray-600">
          Table {sessionInfo.table} • Session active since{' '}
          {sessionInfo.created
            ? new Date(sessionInfo.created).toLocaleTimeString()
            : 'N/A'}
        </p>

        {orders.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Total Orders:</span>
              <span className="font-bold text-xl">{orders.length}</span>
            </div>
            <div className="flex justify-between items-center mt-2">
              <span className="text-gray-600">Total Spent:</span>
              <span className="font-bold text-2xl text-orange-600">
                N${getTotalSpent().toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Orders List */}
      {orders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="text-6xl mb-4">🍽️</div>
          <p className="text-xl text-gray-600 mb-2">No orders yet</p>
          <p className="text-gray-500 mb-6">
            Start by browsing the menu and placing your first order
          </p>
          <button
            onClick={() =>
              router.push(`/menu/${restaurantId}/browse?table=${tableNumber}`)
            }
            className="bg-orange-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-orange-700 transition"
          >
            Browse Menu
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order, index) => {
            const statusConfig = getStatusConfig(order.status)
            // Handle both Firestore Timestamp and ISO string
            const placedAt = order.placed_at?.toDate
              ? order.placed_at.toDate()
              : order.placed_at
              ? (typeof order.placed_at === 'string' ? new Date(order.placed_at) : new Date())
              : new Date()
            const timeAgo = getTimeAgo(placedAt)

            return (
              <div
                key={order.id}
                className="bg-white rounded-lg shadow-lg p-6 hover:shadow-xl transition cursor-pointer"
                onClick={() =>
                  router.push(`/order-confirmation?orderId=${order.id}${tableNumber ? `&table=${tableNumber}` : ''}`)
                }
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-xl font-bold">
                      Order #{order.order_number || order.id.slice(-6).toUpperCase()}
                    </h3>
                    <p className="text-sm text-gray-500">{timeAgo}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-orange-600">
                      N${order.total?.toFixed(2)}
                    </p>
                    <span
                      className={`inline-block px-3 py-1 rounded-full text-sm font-semibold mt-2 ${statusConfig.color}`}
                    >
                      {statusConfig.emoji} {statusConfig.label}
                    </span>
                  </div>
                </div>

                {/* Order Items Preview */}
                <div className="border-t pt-3">
                  <p className="text-sm text-gray-600 mb-2">
                    {order.items?.length || 0} item
                    {order.items?.length !== 1 ? 's' : ''}:
                  </p>
                  <div className="space-y-1">
                    {order.items?.slice(0, 3).map((item: any, idx: number) => (
                      <p key={idx} className="text-sm text-gray-700">
                        {item.quantity}× {item.name}
                      </p>
                    ))}
                    {order.items?.length > 3 && (
                      <p className="text-sm text-gray-500 italic">
                        +{order.items.length - 3} more item
                        {order.items.length - 3 !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>
                </div>

                {/* Payment Status */}
                <div className="mt-3 flex items-center gap-4 text-sm">
                  <span className="text-gray-600">
                    Payment: {order.payment_method === 'card' ? '💳' : '💵'}{' '}
                    {order.payment_method}
                  </span>
                  <span
                    className={`px-2 py-1 rounded text-xs font-semibold ${
                      order.payment_status === 'paid'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {order.payment_status === 'paid' ? '✓ Paid' : '⏳ Pending'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Order More Button */}
      {orders.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() =>
              router.push(`/menu/${restaurantId}/browse?table=${tableNumber}`)
            }
            className="w-full bg-orange-600 text-white py-4 rounded-lg font-semibold text-lg hover:bg-orange-700 transition"
          >
            Order More Items
          </button>
        </div>
      )}
    </div>
  )
}

// Helper function to calculate time ago
function getTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000)

  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
  return `${Math.floor(seconds / 86400)} days ago`
}

