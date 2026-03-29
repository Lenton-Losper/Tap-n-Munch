'use client'

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { doc, onSnapshot, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getCurrentSession, clearSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Clock, Banknote, CreditCard, ArrowLeft } from 'lucide-react'
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
  const [reconcileStartedAt] = useState(() => Date.now())

  useEffect(() => {
    let unsubscribe: (() => void) | null = null

    const loadOrder = async () => {
      try {
        setLoading(true)
        setError(null)

        const sessionId = getCurrentSession()
        let restaurantId: string | null = null
        let effectiveOrderId = orderId
        let effectiveTable = tableNumber
        if (typeof window !== 'undefined') {
          if (!effectiveOrderId) {
            effectiveOrderId = sessionStorage.getItem('flashtap_return_order_id')
            if (effectiveOrderId) sessionStorage.removeItem('flashtap_return_order_id')
          }
          if (!effectiveTable) {
            effectiveTable = sessionStorage.getItem('flashtap_return_table')
            if (effectiveTable) sessionStorage.removeItem('flashtap_return_table')
          }
        }
        const tableNum = effectiveTable ? Number(effectiveTable) : null
        
        if (typeof window !== 'undefined') {
          restaurantId = localStorage.getItem('current_restaurant_id')
        }

        if (!restaurantId) {
          setError('Restaurant ID not found. Please scan the QR code again.')
          setLoading(false)
          return
        }

        if (!tableNum || tableNum <= 0) {
          setError('Table number not found. Please scan the QR code again.')
          setLoading(false)
          return
        }

        if (!db) {
          setError('Database not available')
          setLoading(false)
          return
        }

        try {
          const { orderPath, ordersPath } = require('@/lib/firebase/paths')
          
          if (effectiveOrderId) {
            const orderRef = doc(db, orderPath(restaurantId, effectiveOrderId))
            const ordersRef = collection(db, ordersPath(restaurantId))
            const tableQuery = query(
              ordersRef,
              where('table_number', '==', tableNum),
              where('is_closed', '==', false),
              limit(50)
            )
            
            const tableSnapshot = await getDocs(tableQuery)
            const matchingOrder = tableSnapshot.docs.find(doc => doc.id === effectiveOrderId)
            
            if (matchingOrder) {
              const orderData = { id: matchingOrder.id, ...matchingOrder.data() }
              setOrder(orderData)
              
              if (!restaurant) {
                try {
                  const restaurantData = await getRestaurant(restaurantId)
                  setRestaurant(restaurantData)
                } catch (err) {
                  console.error('Failed to load restaurant:', err)
                }
              }
              
              unsubscribe = onSnapshot(orderRef, (docSnapshot) => {
                if (docSnapshot.exists()) {
                  const updatedOrder: any = { id: docSnapshot.id, ...docSnapshot.data() }
                  if (updatedOrder.table_number === tableNum && !updatedOrder.is_closed) {
                    setOrder(updatedOrder)
                  }
                }
              })
              
              setLoading(false)
            } else {
              setError('Order not found or table mismatch')
              setLoading(false)
            }
          } else {
            const ordersRef = collection(db, ordersPath(restaurantId))
            const q = query(
              ordersRef,
              where('table_number', '==', tableNum),
              where('is_closed', '==', false),
              orderBy('placed_at', 'desc'),
              limit(1)
            )

            try {
              const snapshot = await getDocs(q)

              if (snapshot.empty) {
                setError('No orders yet')
                setLoading(false)
                return
              }

              const orderDoc = snapshot.docs[0]
              const orderData = { id: orderDoc.id, ...orderDoc.data() }
              setOrder(orderData)

              try {
                const restaurantData = await getRestaurant(restaurantId)
                setRestaurant(restaurantData)
              } catch (err) {
                console.error('Failed to load restaurant:', err)
              }

              unsubscribe = onSnapshot(
                doc(db, orderPath(restaurantId, orderDoc.id)),
                async (docSnapshot) => {
                  if (docSnapshot.exists()) {
                    const updatedOrder: any = { id: docSnapshot.id, ...docSnapshot.data() }
                    if (updatedOrder.table_number === tableNum && !updatedOrder.is_closed) {
                      setOrder(updatedOrder)
                    }
                  }
                }
              )

              setLoading(false)
            } catch (err: any) {
              if (err?.code === 'failed-precondition') {
                const allOrdersRef = collection(db, ordersPath(restaurantId))
                const allSnapshot = await getDocs(query(allOrdersRef, where('table_number', '==', tableNum), limit(50)))
                
                const filteredOrders = allSnapshot.docs
                  .map((doc): any => ({ id: doc.id, ...doc.data() }))
                  .filter((order: any) => order.table_number === tableNum && !order.is_closed)
                  .sort((a: any, b: any) => {
                    const aTime = a.placed_at?.toMillis?.() || a.placed_at || 0
                    const bTime = b.placed_at?.toMillis?.() || b.placed_at || 0
                    return bTime - aTime
                  })
                
                if (filteredOrders.length > 0) {
                  setOrder(filteredOrders[0])
                  try {
                    const restaurantData = await getRestaurant(restaurantId)
                    setRestaurant(restaurantData)
                  } catch (restErr) {
                    console.error('Failed to load restaurant:', restErr)
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
          setError(err.message || 'Failed to load order')
          setLoading(false)
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load order')
        setLoading(false)
      }
    }

    loadOrder()

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [orderId, restaurant, tableNumber, searchParams])

  useEffect(() => {
    if (!order?.id || order?.payment_method !== 'card' || order?.payment_status === 'paid') return
    const restaurantId =
      order?.restaurant_id ||
      (typeof window !== 'undefined' ? localStorage.getItem('current_restaurant_id') : null)
    if (!restaurantId) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const FIRST_WINDOW_MS = 60_000
    const SECOND_WINDOW_MS = 15 * 60_000

    const run = async () => {
      if (cancelled) return
      const elapsed = Date.now() - reconcileStartedAt
      if (elapsed > SECOND_WINDOW_MS) return
      try {
        await fetch('/api/payments/reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantId,
            orderIds: [String(order.id)],
            merchantOrderNo: String(order.payment_reference || `${restaurantId}:${order.id}`),
          }),
        })
      } catch {
        // best-effort polling; Firestore listener still reflects webhook success
      }
      const next = elapsed < FIRST_WINDOW_MS ? 5000 : 30000
      timer = setTimeout(run, next)
    }
    run()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [order, reconcileStartedAt])

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading your receipt...</p>
        </div>
      </div>
    )
  }

  if (error && !order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-12 text-center">
          {error === 'No active session' ? (
            <>
              <div className="text-6xl mb-6">🍽️</div>
              <h1 className="text-2xl font-serif font-bold text-foreground mb-4">No Active Order</h1>
              <p className="text-muted-foreground font-sans mb-6">
                Please scan the QR code to start ordering.
              </p>
              <Button onClick={() => router.push('/')} className="bg-foreground text-background hover:bg-foreground/90 font-sans">
                Go to Home
              </Button>
            </>
          ) : error === 'No orders yet' ? (
            <>
              <div className="text-6xl mb-6">📋</div>
              <h1 className="text-2xl font-serif font-bold text-foreground mb-4">No Orders Yet</h1>
              <p className="text-muted-foreground font-sans mb-6">
                You haven't placed any orders yet.
              </p>
              <Button onClick={() => router.back()} className="bg-foreground text-background hover:bg-foreground/90 font-sans">
                Go Back
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-serif font-bold text-foreground mb-4">Order Not Found</h1>
              <p className="text-muted-foreground font-sans mb-6">{error}</p>
              <Button onClick={() => router.back()} className="bg-foreground text-background hover:bg-foreground/90 font-sans">
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
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading order details...</p>
        </div>
      </div>
    )
  }

  const statusConfig: Record<string, { emoji: string; title: string; message: string }> = {
    new: {
      emoji: '🎉',
      title: 'Order Received',
      message: 'Your order has been received. A staff member will start preparing it shortly.',
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

  const currentStatus = statusConfig[order?.status] || statusConfig.new

  const handleEndSession = () => {
    if (confirm('Are you sure you want to end your session?')) {
      clearSession()
      alert('Session ended. Thank you!')
      const restId = order?.restaurant_id || (typeof window !== 'undefined' ? localStorage.getItem('current_restaurant_id') : null)
      const tableNum = tableNumber || order?.table_number
      if (restId && tableNum) {
        router.push(`/menu/${restId}/v2?table=${tableNum}`)
      } else {
        router.push('/')
      }
    }
  }

  const placedAtDate = order?.placed_at?.toDate 
    ? order.placed_at.toDate() 
    : order?.placed_at 
    ? (typeof order.placed_at === 'string' ? new Date(order.placed_at) : new Date())
    : new Date()

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-6">
        {/* Status Banner */}
        <div className="bg-card border border-border p-8 mb-6 text-center">
          <div className="text-6xl mb-4">{currentStatus.emoji}</div>
          <h1 className="text-3xl font-serif font-bold text-foreground mb-2">{currentStatus.title}</h1>
          <p className="text-muted-foreground font-sans">{currentStatus.message}</p>
        </div>

        {/* Order Details */}
        <div className="bg-card border border-border p-6 mb-6">
          {!orderId && (
            <div className="bg-muted border border-border p-3 mb-6">
              <p className="text-sm text-muted-foreground font-sans">
                📋 Showing your most recent order
              </p>
            </div>
          )}
          
          <div className="flex justify-between items-start mb-6 pb-6 border-b border-border">
            <div>
              <h2 className="text-2xl font-sans font-bold text-foreground">
                Order #{order?.order_number || order?.id?.slice(-6)?.toUpperCase() || 'N/A'}
              </h2>
              {order?.table_number > 0 && (
                <p className="text-muted-foreground font-sans text-sm">Table {order.table_number}</p>
              )}
              <p className="text-sm text-muted-foreground font-sans mt-1">
                {placedAtDate?.toLocaleString() || 'N/A'}
              </p>
            </div>
            <p className="text-3xl font-bold text-foreground font-sans">
              {restaurant?.currency || 'N$'}{order?.total?.toFixed(2) || '0.00'}
            </p>
          </div>

          {/* Payment Info */}
          <div className="bg-muted p-4 mb-6">
            <h3 className="font-semibold font-sans text-foreground mb-3">Payment</h3>
            <div className="flex items-center justify-between mb-2 text-sm font-sans">
              <span className="text-muted-foreground">Method:</span>
              <div className="flex items-center gap-2 text-foreground font-semibold">
                {order?.payment_method === 'card' ? (
                  <CreditCard className="h-4 w-4 stroke-[1.5]" />
                ) : (
                  <Banknote className="h-4 w-4 stroke-[1.5]" />
                )}
                <span className="capitalize">{order?.payment_method || 'cash'}</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-sm font-sans">
              <span className="text-muted-foreground">Status:</span>
              {order?.payment_status === 'paid' ? (
                <span className="inline-flex items-center px-2 py-1 bg-foreground text-background text-xs font-semibold uppercase">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Paid
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-1 bg-muted border border-border text-foreground text-xs font-semibold uppercase">
                  <Clock className="h-3 w-3 mr-1" />
                  Pending
                </span>
              )}
            </div>
            {order?.payment_method === 'card' && order?.payment_status === 'pending' && (
              <p className="mt-3 text-xs text-muted-foreground font-sans">
                Waiting for payment confirmation. This page checks status automatically.
              </p>
            )}
          </div>

          {/* Order Items */}
          <div className="border-t border-border pt-6">
            <h3 className="font-semibold font-sans text-foreground mb-4">Order Summary</h3>
            <div className="space-y-3">
              {order?.items?.length > 0 ? (
                order.items.map((item: any, index: number) => (
                  <div key={index} className="flex justify-between items-center text-sm font-sans">
                    <span className="text-muted-foreground">
                      {item?.quantity || 1}× {item?.name || 'Unknown Item'}
                    </span>
                    <span className="font-semibold text-foreground">
                      {restaurant?.currency || 'N$'}{(item?.subtotal || 0).toFixed(2)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground font-sans text-sm">No items found.</p>
              )}
            </div>
          </div>

          {/* Special Instructions */}
          {order?.order_instructions && (
            <div className="bg-muted border border-border p-4 mt-6">
              <p className="text-sm font-semibold text-foreground font-sans mb-1">📝 Special Instructions:</p>
              <p className="text-sm text-muted-foreground font-sans">{order.order_instructions}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-3">
          {order?.restaurant_id && (
            <Link 
              href={`/menu/${order.restaurant_id}/browse${tableNumber ? `?table=${tableNumber}` : ''}`}
              className="block"
            >
              <Button className="w-full bg-foreground text-background hover:bg-foreground/90 py-6 font-semibold text-base font-sans">
                Order More
              </Button>
            </Link>
          )}

          {order?.restaurant_id && order?.table_number && (
            <button
              onClick={() => router.push(`/menu/${order.restaurant_id}/my-orders?table=${order.table_number}`)}
              className="w-full bg-card border border-border text-foreground py-4 font-semibold text-base hover:bg-muted transition font-sans"
            >
              📋 View All My Orders
            </button>
          )}

          <button
            onClick={handleEndSession}
            className="w-full bg-card border border-destructive text-destructive py-3 font-semibold hover:bg-destructive/10 transition font-sans"
          >
            End My Session
          </button>
        </div>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
            <p className="mt-6 text-muted-foreground font-sans">Loading order confirmation...</p>
          </div>
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  )
}
