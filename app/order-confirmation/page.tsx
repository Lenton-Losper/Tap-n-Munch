 'use client'

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { doc, onSnapshot, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getCurrentSession, clearSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, Clock, Banknote, CreditCard } from 'lucide-react'
import Link from 'next/link'

function OrderConfirmationContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const orderId = searchParams.get('orderId')
  const tableNumber = searchParams.get('table')

  const [order, setOrder] = useState<any>(null)
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadOrder = async () => {
      try {
        setLoading(true)
        setError(null)

        // Get session_id from localStorage for security verification
        const sessionId = getCurrentSession()
        console.log('🔍 [CONFIRMATION] Loading order with session:', {
          orderId: orderId || 'none',
          sessionId: sessionId || 'none',
          tableNumber: tableNumber || 'none'
        })

        // If orderId is provided, use it with session verification
        if (orderId && db) {
          if (!sessionId) {
            console.error('❌ [CONFIRMATION ERROR] No session ID available')
            setError('No active session. Please scan the QR code again.')
            setLoading(false)
            return
          }

          try {
            // Strategy: Query orders by session_id to find the order and extract restaurantId
            // Since orders are hierarchical (restaurants/{restaurantId}/orders), we need restaurantId
            // Try to get restaurantId from localStorage (stored during QR scan)
            let restaurantId: string | null = null
            if (typeof window !== 'undefined') {
              restaurantId = localStorage.getItem('current_restaurant_id')
            }

            // If we have restaurantId, query directly using hierarchical path
            if (restaurantId) {
              console.log('🔍 [CONFIRMATION] Using restaurantId from localStorage:', restaurantId)
              const { orderPath } = require('@/lib/firebase/paths')
              const orderRef = doc(db, orderPath(restaurantId, orderId))
              
              // Query orders by session_id to find the matching order
              // This ensures security rules pass (query includes session_id)
              const ordersRef = collection(db, `restaurants/${restaurantId}/orders`)
              const sessionQuery = query(
                ordersRef,
                where('session_id', '==', sessionId),
                limit(20) // Get recent orders to find the one matching orderId
              )
              
              const sessionSnapshot = await getDocs(sessionQuery)
              
              // Find the order that matches orderId
              const matchingOrder = sessionSnapshot.docs.find(doc => doc.id === orderId)
              
              if (matchingOrder) {
                const orderData = { id: matchingOrder.id, ...matchingOrder.data() }
                console.log('✅ [CONFIRMATION] Order loaded with session verification:', orderData)
                setOrder(orderData)
                
                // Load restaurant data
                if (!restaurant) {
                  try {
                    const restaurantData = await getRestaurant(restaurantId)
                    setRestaurant(restaurantData)
                  } catch (err) {
                    console.error('Failed to load restaurant:', err)
                  }
                }
                
                // Set up real-time listener using hierarchical path
                const unsubscribe = onSnapshot(orderRef, (docSnapshot) => {
                  if (docSnapshot.exists()) {
                    const updatedOrder = { id: docSnapshot.id, ...docSnapshot.data() }
                    // Verify session still matches
                    if (updatedOrder.session_id === sessionId) {
                      setOrder(updatedOrder)
                      console.log('✅ [CONFIRMATION] Order updated in real-time')
                    } else {
                      console.warn('⚠️ [CONFIRMATION] Order session mismatch in real-time update')
                    }
                  }
                }, (error) => {
                  console.error('Error in real-time listener:', error)
                  if (error?.code === 'permission-denied') {
                    console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied')
                  }
                })
                
                setLoading(false)
                return () => unsubscribe()
              } else {
                // Order ID not found in session orders
                console.error('❌ [CONFIRMATION ERROR] Order not found with this session')
                setError('Order not found or session expired')
                setLoading(false)
                return
              }
            } else {
              // No restaurantId - query by session_id across all restaurants (if collectionGroup allowed)
              // For now, show error asking user to scan QR again
              console.error('❌ [CONFIRMATION ERROR] Restaurant ID not found. Please scan QR code again.')
              setError('Restaurant ID not found. Please scan the QR code again to access your order.')
              setLoading(false)
              return
            }
          } catch (err: any) {
            console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied:', err)
            if (err?.code === 'permission-denied' || err?.message?.includes('permission')) {
              setError('Permission denied: Order not found or session mismatch')
            } else {
              setError(err.message || 'Failed to load order')
            }
            setLoading(false)
            return
          }
        } 
        // If no orderId, try to fetch most recent order from session
        else {
          // sessionId is already declared at the top of the function
          if (!sessionId) {
            console.log('No session found')
            setError('No active session')
            setLoading(false)
            return
          }

          if (!db) {
            console.error('Firestore not initialized')
            setError('Database not available')
            setLoading(false)
            return
          }

          // Get restaurantId from localStorage
          let restaurantId: string | null = null
          if (typeof window !== 'undefined') {
            restaurantId = localStorage.getItem('current_restaurant_id')
          }

          if (!restaurantId) {
            console.error('❌ [CONFIRMATION ERROR] Restaurant ID not found. Please scan QR code again.')
            setError('Restaurant ID not found. Please scan the QR code again to access your orders.')
            setLoading(false)
            return
          }

          console.log('🔍 [CONFIRMATION] Fetching most recent order for session:', sessionId, 'restaurant:', restaurantId)

          // Query Firestore for most recent order in this session using hierarchical path
          const ordersRef = collection(db, `restaurants/${restaurantId}/orders`)
          const q = query(
            ordersRef,
            where('session_id', '==', sessionId),
            orderBy('placed_at', 'desc'),
            limit(1)
          )

          try {
            const snapshot = await getDocs(q)

            if (snapshot.empty) {
              console.log('No orders found for session')
              setError('No orders yet')
              setLoading(false)
              return
            }

            // Get the most recent order
            const orderDoc = snapshot.docs[0]
            const orderData = { id: orderDoc.id, ...orderDoc.data() }
            setOrder(orderData)
            console.log('✅ [CONFIRMATION] Most recent order loaded from session:', orderData)

            // Load restaurant data
            if (orderData.restaurant_id) {
              try {
                const restaurantData = await getRestaurant(orderData.restaurant_id)
                setRestaurant(restaurantData)
              } catch (err) {
                console.error('Failed to load restaurant:', err)
              }
            }

            // Set up real-time listener for this order using hierarchical path
            const { orderPath } = require('@/lib/firebase/paths')
            const unsubscribe = onSnapshot(
              doc(db, orderPath(restaurantId, orderDoc.id)),
              async (docSnapshot) => {
                if (docSnapshot.exists()) {
                  const updatedOrder = { id: docSnapshot.id, ...docSnapshot.data() }
                  // Verify session still matches
                  if (updatedOrder.session_id === sessionId) {
                    setOrder(updatedOrder)
                    console.log('✅ [CONFIRMATION] Order updated in real-time:', updatedOrder)
                  } else {
                    console.warn('⚠️ [CONFIRMATION] Order session mismatch in real-time update')
                  }
                }
              },
              (error) => {
                console.error('Error in real-time listener:', error)
                if (error?.code === 'permission-denied') {
                  console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied')
                }
              }
            )

            setLoading(false)
            return () => unsubscribe()
          } catch (err: any) {
            console.error('❌ [CONFIRMATION ERROR] Failed to fetch orders:', err)
            if (err?.code === 'permission-denied' || err?.message?.includes('permission')) {
              console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied')
              setError('Permission denied: Order not found or session mismatch')
            } else if (err?.code === 'failed-precondition') {
              // Missing index - filter in memory instead
              console.warn('⚠️ [CONFIRMATION] Index missing, filtering in memory')
              const allOrdersRef = collection(db, `restaurants/${restaurantId}/orders`)
              const allSnapshot = await getDocs(query(allOrdersRef, where('session_id', '==', sessionId), limit(20)))
              
              if (allSnapshot.empty) {
                setError('No orders yet')
                setLoading(false)
                return
              }
              
              // Sort by placed_at in memory
              const sortedOrders = allSnapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(order => order.session_id === sessionId)
                .sort((a, b) => {
                  const aTime = a.placed_at?.toMillis?.() || a.placed_at || 0
                  const bTime = b.placed_at?.toMillis?.() || b.placed_at || 0
                  return bTime - aTime
                })
              
              if (sortedOrders.length > 0) {
                const orderData = sortedOrders[0]
                setOrder(orderData)
                
                if (orderData.restaurant_id && !restaurant) {
                  try {
                    const restaurantData = await getRestaurant(orderData.restaurant_id)
                    setRestaurant(restaurantData)
                  } catch (restErr) {
                    console.error('Failed to load restaurant:', restErr)
                  }
                }
                
                setLoading(false)
              } else {
                setError('No orders yet')
                setLoading(false)
              }
            } else {
              setError(err.message || 'Failed to load order')
              setLoading(false)
            }
          }
        }
      } catch (err: any) {
        console.error('Error in loadOrder:', err)
        setError(err.message || 'Failed to load order')
        setLoading(false)
      }
    }

    const cleanup = loadOrder()
    return () => {
      if (cleanup && typeof cleanup.then) {
        // If cleanup is a promise, we can't cancel it, but that's okay
      }
    }
  }, [orderId, restaurant])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your receipt...</p>
        </div>
      </div>
    )
  }

  // Handle error states
  if (error && !order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          {error === 'No active session' ? (
            <>
              <div className="text-6xl mb-4">🍽️</div>
              <h1 className="text-2xl font-bold text-gray-800 mb-2">No Active Order</h1>
              <p className="text-gray-600 mb-4">
                You don't have an active session. Please scan the QR code to start ordering.
              </p>
              <Button onClick={() => router.push('/')} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Go to Home
              </Button>
            </>
          ) : error === 'No orders yet' ? (
            <>
              <div className="text-6xl mb-4">📋</div>
              <h1 className="text-2xl font-bold text-gray-800 mb-2">No Orders Yet</h1>
              <p className="text-gray-600 mb-4">
                You haven't placed any orders in this session yet.
              </p>
              <Button onClick={() => router.back()} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Go Back
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-red-600 mb-2">Order Not Found</h1>
              <p className="text-gray-600 mb-4">
                {error || 'We couldn\'t find that order. Please check with a staff member if you\'re unsure.'}
              </p>
              <Button onClick={() => router.back()} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Go Back
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Order Not Found</h1>
          <p className="text-gray-600 mb-4">
            We couldn't find that order. Please check with a staff member if you're unsure.
          </p>
          <Button onClick={() => router.back()} className="bg-[#FF6B35] hover:bg-[#e55a28]">
            Go Back
          </Button>
        </div>
      </div>
    )
  }

  // PART 2: Standardize Order Status Model
  // Status messages and emojis
  const statusConfig: Record<string, { emoji: string; title: string; message: string }> = {
    new: {
      emoji: '🎉',
      title: 'Order Received',
      message: 'Your order has been received by the restaurant. A staff member will start preparing it shortly.',
    },
    accepted: {
      emoji: '👨‍🍳',
      title: 'Order Accepted',
      message: 'The restaurant is preparing your order.',
    },
    preparing: {
      emoji: '🔥',
      title: 'Being Prepared',
      message: 'Your food is being prepared right now.',
    },
    ready: {
      emoji: '✅',
      title: 'Order Ready!',
      message: 'Your order is ready! A staff member will bring it to your table.',
    },
    completed: {
      emoji: '✨',
      title: 'Completed',
      message: 'Thank you for your order! Enjoy your meal.',
    },
  }

  const currentStatus = statusConfig[order.status] || statusConfig.new

  const handleEndSession = () => {
    if (confirm('Are you sure you want to end your session? This will clear your session from this device.')) {
      clearSession()
      alert('Session ended. Thank you for dining with us!')
      router.push('/')
    }
  }

  // Parse placed_at timestamp - handle both Firestore Timestamp and ISO string
  const placedAtDate = order.placed_at?.toDate 
    ? order.placed_at.toDate() 
    : order.placed_at 
    ? (typeof order.placed_at === 'string' ? new Date(order.placed_at) : new Date())
    : new Date()

  return (
    <div className="max-w-2xl mx-auto p-6 min-h-screen bg-gray-50">
      {/* Status Banner */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6 text-center">
        <div className="text-6xl mb-4">{currentStatus.emoji}</div>
        <h1 className="text-3xl font-bold mb-2">{currentStatus.title}</h1>
        <p className="text-gray-600">{currentStatus.message}</p>
      </div>

      {/* Order Details Card */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        {/* Show indicator if loaded from session (no orderId in URL) */}
        {!orderId && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-blue-800">
              📋 Showing your most recent order from this session
            </p>
          </div>
        )}
        
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-2xl font-bold">
              Order #{order.order_number || order.id.slice(-6).toUpperCase()}
            </h2>
            {order.table_number > 0 && (
              <p className="text-gray-600">Table {order.table_number}</p>
            )}
            <p className="text-sm text-gray-500 mt-1">
              {placedAtDate.toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold text-orange-600">
              {restaurant?.currency || 'N$'}{order.total?.toFixed(2)}
            </p>
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
          <h3 className="font-semibold mb-2">Payment</h3>
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-gray-700">Method:</span>
            <div className="flex items-center gap-2">
              {order.payment_method === 'cash' ? (
                <Banknote className="h-4 w-4 text-gray-600" />
              ) : (
                <CreditCard className="h-4 w-4 text-gray-600" />
              )}
              <span className="font-semibold capitalize">
                {order.payment_method}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700">Status:</span>
            {order.payment_status === 'paid' ? (
              <Badge className="bg-green-500 text-white">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Paid
              </Badge>
            ) : (
              <Badge variant="outline" className="border-yellow-500 text-yellow-700 bg-yellow-50">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </Badge>
            )}
          </div>
        </div>

        {/* Order Items */}
        <div className="border-t border-b py-4 my-4">
          <h3 className="font-semibold mb-3 text-lg">Order Summary</h3>
          <div className="space-y-2">
            {order.items && Array.isArray(order.items) && order.items.length > 0 ? (
              order.items.map((item: any, index: number) => (
                <div key={index} className="flex justify-between items-center">
                  <span className="text-gray-700">
                    {item.quantity || 1}× {item.name || 'Unknown Item'}
                  </span>
                  <span className="font-semibold">
                    {restaurant?.currency || 'N$'}{(item.subtotal || (item.price || 0) * (item.quantity || 1) || 0).toFixed(2)}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-gray-500 text-sm">No items found in this order.</p>
            )}
          </div>
        </div>

        {/* Payment Info */}
        <div className="space-y-2 mb-4">
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Payment Method:</span>
            <span className="font-semibold capitalize flex items-center gap-2">
              {order.payment_method === 'card' ? '💳' : '💵'}
              {order.payment_method}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Payment Status:</span>
            <span
              className={`px-3 py-1 rounded-full text-sm font-semibold ${
                order.payment_status === 'paid'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800'
              }`}
            >
              {order.payment_status === 'paid' ? '✓ Paid' : '⏳ Pending'}
            </span>
          </div>
        </div>

        {/* Special Instructions */}
        {order.order_instructions && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-4">
            <p className="text-sm font-semibold text-yellow-800 mb-1">
              📝 Special Instructions:
            </p>
            <p className="text-sm text-yellow-700">
              {order.order_instructions}
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-3 mb-6">
        {order.restaurant_id && (
          <Link 
            href={`/menu/${order.restaurant_id}/browse${tableNumber ? `?table=${tableNumber}` : ''}`}
            className="block"
          >
            <Button className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white py-4 rounded-lg font-semibold text-lg">
              Order More
            </Button>
          </Link>
        )}

        {/* View All My Orders Button */}
        {order.restaurant_id && order.table_number && (
          <button
            onClick={() =>
              router.push(`/menu/${order.restaurant_id}/my-orders?table=${order.table_number}`)
            }
            className="w-full bg-white border-2 border-orange-600 text-orange-600 py-4 rounded-lg font-semibold text-lg hover:bg-orange-50 transition"
          >
            📋 View All My Orders
          </button>
        )}

        <button
          onClick={handleEndSession}
          className="w-full bg-white border-2 border-red-300 text-red-600 py-3 rounded-lg font-semibold hover:bg-red-50 transition"
        >
          End My Session
        </button>
      </div>

      {/* Helpful Tips */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="font-semibold text-blue-900 mb-2">💡 Helpful Tips:</p>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Bookmark this page to check your order status anytime</li>
          <li>This page updates automatically - no need to refresh</li>
          <li>Visit "My Orders" to see all your orders from this session</li>
        </ul>
      </div>

      {/* Bookmark Reminder */}
      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
        <p className="font-semibold text-yellow-900 mb-2">⭐ Important!</p>
        <p className="text-sm text-yellow-800 mb-3">
          Bookmark this page or save this link to check your order anytime:
        </p>
        <div className="bg-white border border-yellow-300 rounded p-2 text-xs break-all mb-2">
          {typeof window !== 'undefined' ? window.location.href : ''}
        </div>
        <button
          onClick={() => {
            if (typeof window !== 'undefined') {
              navigator.clipboard.writeText(window.location.href)
              alert('Link copied! Paste it in your notes app.')
            }
          }}
          className="bg-yellow-600 text-white px-4 py-2 rounded text-sm font-semibold hover:bg-yellow-700 transition"
        >
          📋 Copy Link
        </button>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading order confirmation...</p>
          </div>
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  )
}




