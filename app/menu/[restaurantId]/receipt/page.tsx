'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, orderBy, onSnapshot, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'

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
    const tableNum = tableNumber ? Number(tableNumber) : null

    if (!tableNum || tableNum <= 0) {
      setLoading(false)
      return
    }

    if (!db || !restaurantId) {
      setLoading(false)
      return
    }

    // Load restaurant data
    if (restaurantId && !restaurant) {
      getRestaurant(restaurantId).then((restaurantData) => {
        setRestaurant(restaurantData)
      }).catch((err) => {
        console.error('Failed to load restaurant:', err)
      })
    }

    // Real-time listener for orders
    const { ordersPath } = require('@/lib/firebase/paths')
    const ordersRef = collection(db, ordersPath(restaurantId))
    
    let q = query(
      ordersRef,
      where('table_number', '==', tableNum),
      where('is_closed', '==', false),
      orderBy('placed_at', 'desc')
    )

    let unsubscribeFn: (() => void) | null = null

    const setupListener = () => {
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const ordersList = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }))
          setOrders(ordersList)
          setLoading(false)
        },
        (error: any) => {
          console.error('Error loading receipt:', error)
          
          if (error?.code === 'failed-precondition') {
            try {
              const fallbackQuery = query(
                ordersRef,
                where('table_number', '==', tableNum),
                where('is_closed', '==', false),
                limit(50)
              )
              
              const fallbackUnsubscribe = onSnapshot(
                fallbackQuery,
                (fallbackSnapshot) => {
                  const filteredOrders = fallbackSnapshot.docs
                    .map(doc => ({ id: doc.id, ...doc.data() }))
                    .filter(order => order.table_number === tableNum && !order.is_closed)
                    .sort((a, b) => {
                      const aTime = a.placed_at?.toMillis?.() || a.placed_at || 0
                      const bTime = b.placed_at?.toMillis?.() || b.placed_at || 0
                      return bTime - aTime
                    })
                  
                  setOrders(filteredOrders)
                  setLoading(false)
                },
                (fallbackErr: any) => {
                  if (fallbackErr?.code === 'permission-denied') {
                    setOrders([])
                  }
                  setLoading(false)
                }
              )
              
              unsubscribeFn = fallbackUnsubscribe
            } catch (fallbackErr) {
              setLoading(false)
            }
          } else if (error?.code === 'permission-denied') {
            setOrders([])
            setLoading(false)
          } else {
            setLoading(false)
          }
        }
      )
      
      unsubscribeFn = unsubscribe
    }

    setupListener()

    return () => {
      if (unsubscribeFn) unsubscribeFn()
    }
  }, [restaurantId, tableNumber, restaurant])

  const tableNum = tableNumber ? Number(tableNumber) : null
  
  // No table number
  if (!loading && (!tableNum || tableNum <= 0)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-12 text-center">
          <div className="text-6xl mb-6">📋</div>
          <h1 className="text-2xl font-serif font-bold text-foreground mb-4">Table Number Required</h1>
          <p className="text-muted-foreground font-sans mb-6">
            Please scan the QR code at your table to view your receipt.
          </p>
          {restaurantId && (
            <Link href={`/menu/${restaurantId}/browse`}>
              <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans">
                Browse Menu
              </Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

  // Loading
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading receipt...</p>
        </div>
      </div>
    )
  }

  // Data safety
  if (!orders || !Array.isArray(orders)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading receipt...</p>
        </div>
      </div>
    )
  }

  // No orders
  if (orders.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-12 text-center">
          <div className="text-6xl mb-6">📋</div>
          <h1 className="text-2xl font-serif font-bold text-foreground mb-4">No Orders Yet</h1>
          <p className="text-muted-foreground font-sans mb-6">
            {tableNumber 
              ? `No active orders found for Table ${tableNumber}.`
              : 'No active orders found.'}
          </p>
          {restaurantId && tableNumber && (
            <Link href={`/menu/${restaurantId}/browse?table=${tableNumber}`}>
              <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans">
                Browse Menu
              </Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

  const total = orders.reduce((sum, order) => sum + (order?.total || 0), 0)

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-6">
        {/* Receipt Header */}
        <div className="bg-card border border-border p-8 mb-6">
          {/* Back Button */}
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-foreground font-sans font-semibold mb-6 hover:opacity-70 transition"
          >
            <ArrowLeft className="w-4 h-4 stroke-[1.5]" />
            Back
          </button>

          {/* Restaurant Name */}
          <div className="text-center border-b border-border pb-6 mb-6">
            <h1 className="text-3xl font-serif font-bold text-foreground mb-2">
              {restaurant?.name || 'Receipt'}
            </h1>
            <p className="text-muted-foreground font-sans text-sm">
              Table {tableNumber} • {orders.length} Order{orders.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Summary */}
          <div className="space-y-3">
            <div className="flex justify-between items-center font-sans">
              <span className="text-muted-foreground">Total Orders</span>
              <span className="font-bold text-foreground">{orders.length}</span>
            </div>
            <div className="flex justify-between items-center font-sans border-t border-border pt-3">
              <span className="text-lg font-semibold text-foreground">Total Amount</span>
              <span className="text-2xl font-bold text-foreground">
                {restaurant?.currency || 'N$'}{total.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Orders List */}
        <div className="space-y-4">
          {orders.map((order) => {
            if (!order) return null
            
            const createdDate = order.created_at?.toDate
              ? order.created_at.toDate()
              : order.created_at
              ? new Date(order.created_at)
              : new Date()

            const orderTotal = typeof order.total === 'number' ? order.total : 0

            return (
              <div key={order.id || Math.random()} className="bg-card border border-border p-6">
                {/* Order Header */}
                <div className="flex justify-between items-start mb-4 pb-4 border-b border-border">
                  <div>
                    <h3 className="font-sans font-bold text-foreground text-lg">
                      Order #{order.order_number || order.id?.slice(-6)?.toUpperCase() || 'N/A'}
                    </h3>
                    <p className="text-sm text-muted-foreground font-sans">
                      {createdDate?.toLocaleString() || 'N/A'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-foreground font-sans">
                      {restaurant?.currency || 'N$'}{orderTotal.toFixed(2)}
                    </p>
                    <span className="inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wide bg-muted text-foreground mt-2">
                      {order.status || 'unknown'}
                    </span>
                  </div>
                </div>

                {/* Order Items */}
                {order.items && Array.isArray(order.items) && order.items.length > 0 ? (
                  <div className="space-y-2">
                    {order.items.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-sm font-sans">
                        <span className="text-muted-foreground">
                          {(item?.quantity || 1)}× {item?.name || 'Unknown Item'}
                        </span>
                        <span className="font-semibold text-foreground">
                          {restaurant?.currency || 'N$'}{((item?.subtotal || 0)).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground font-sans text-sm">No items found</p>
                )}
              </div>
            )
          })}
        </div>

        {/* Order More Button */}
        {restaurantId && (
          <div className="mt-8">
            <Link href={`/menu/${restaurantId}/browse?table=${tableNumber}`}>
              <Button className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base">
                Order More
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
