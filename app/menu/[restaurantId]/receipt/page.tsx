'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, orderBy, onSnapshot, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

/** Firestore Timestamp, plain object, ISO string, or millis — never pass invalid values to `new Date` alone. */
function formatOrderTimestamp(value: unknown): string {
  if (value == null) return '—'

  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const toDate = (value as { toDate?: () => Date }).toDate
    if (typeof toDate === 'function') {
      const d = toDate.call(value)
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toLocaleString()
    }
  }

  if (typeof value === 'object' && value !== null && 'seconds' in value) {
    const sec = Number((value as { seconds: number }).seconds)
    if (Number.isFinite(sec)) return new Date(sec * 1000).toLocaleString()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString()
  }

  return '—'
}

export default function ReceiptPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''
  
  const [orders, setOrders] = useState<any[]>([])
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentSubmitting, setPaymentSubmitting] = useState(false)
  const [paymentSuccess, setPaymentSuccess] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)

  const [cardHolder, setCardHolder] = useState('')
  const [cardNo, setCardNo] = useState('')
  const [expiryMmYy, setExpiryMmYy] = useState('')
  const [cvv, setCvv] = useState('')

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

  const unpaidOrders = orders.filter((o) => o && o.payment_status !== 'paid')
  const payableTotal = unpaidOrders.reduce((sum, order) => sum + (Number(order?.total) || 0), 0)
  const allPaid = orders.length > 0 && unpaidOrders.length === 0

  // If PayCloud webhook updates Firestore before the API response returns, treat as success.
  useEffect(() => {
    if (allPaid && (paymentSubmitting || showPaymentForm)) {
      setPaymentSuccess(true)
      setPaymentSubmitting(false)
      setShowPaymentForm(false)
      setPaymentError(null)
    }
  }, [allPaid, paymentSubmitting, showPaymentForm])

  const parseExpiryMmYy = (raw: string) => {
    const cleaned = raw.replace(/\s/g, '')
    const parts = cleaned.split('/').map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) return null
    const mm = parts[0].padStart(2, '0').slice(-2)
    let yy = parts[1]
    if (yy.length === 2) yy = `20${yy}`
    if (!/^\d{2}$/.test(mm) || !/^\d{4}$/.test(yy)) return null
    return { expireMonth: mm, expireYear: yy }
  }

  const submitPayment = async () => {
    setPaymentError(null)
    const tableNum = tableNumber ? Number(tableNumber) : 0
    if (!restaurantId || !tableNum) {
      setPaymentError('Missing table or restaurant.')
      return
    }
    if (!cardHolder.trim() || !cardNo.trim() || !expiryMmYy.trim() || !cvv.trim()) {
      setPaymentError('Please fill in all card fields.')
      return
    }
    const expiry = parseExpiryMmYy(expiryMmYy)
    if (!expiry) {
      setPaymentError('Use expiry as MM/YY (e.g. 03/29).')
      return
    }

    setPaymentSubmitting(true)
    try {
      const res = await fetch('/api/payments/receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId,
          tableNumber: tableNum,
          orderIds: unpaidOrders.map((o) => o.id),
          amount: payableTotal,
          card: {
            cardHolder: cardHolder.trim(),
            cardNo: cardNo.replace(/\s+/g, ''),
            expireMonth: expiry.expireMonth,
            expireYear: expiry.expireYear,
            cvv: cvv.trim(),
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Payment failed (${res.status})`)
      }
      if (data.requires3ds && data.checkoutUrl) {
        window.location.href = data.checkoutUrl
        return
      }
      setPaymentSuccess(true)
      setShowPaymentForm(false)
      setCardNo('')
      setCvv('')
    } catch (e: unknown) {
      setPaymentError(e instanceof Error ? e.message : 'Payment failed')
    } finally {
      setPaymentSubmitting(false)
    }
  }

  if (paymentSuccess) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-10 text-center space-y-4">
          <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto stroke-[1.5]" aria-hidden />
          <h1 className="text-2xl font-serif font-bold text-foreground">Payment successful!</h1>
          <p className="text-muted-foreground font-sans">
            Your order is being prepared.
          </p>
          {restaurantId && tableNumber && (
            <Link href={`/menu/${restaurantId}/browse?table=${tableNumber}`}>
              <Button className="w-full mt-4 bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6">
                Back to menu
              </Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

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
            
            const displayDate = formatOrderTimestamp(order.placed_at ?? order.created_at)

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
                      {displayDate}
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

        {/* Pay — unpaid table total */}
        {unpaidOrders.length > 0 && (
          <div className="mt-8 space-y-4">
            {!showPaymentForm ? (
              <Button
                type="button"
                onClick={() => {
                  setShowPaymentForm(true)
                  setPaymentError(null)
                }}
                className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
              >
                Pay Now — {restaurant?.currency || 'N$'}
                {payableTotal.toFixed(2)}
              </Button>
            ) : (
              <div className="bg-card border border-border p-5 sm:p-6 space-y-4">
                <h2 className="text-lg font-serif font-bold text-foreground">Pay with card</h2>
                <p className="text-sm text-muted-foreground font-sans">
                  Total due:{' '}
                  <span className="font-semibold text-foreground">
                    {restaurant?.currency || 'N$'}
                    {payableTotal.toFixed(2)}
                  </span>
                </p>

                <div className="space-y-3">
                  <div>
                    <Label htmlFor="rcpt-cardholder" className="text-foreground font-sans text-sm">
                      Cardholder name
                    </Label>
                    <input
                      id="rcpt-cardholder"
                      autoComplete="cc-name"
                      className="mt-1 w-full border border-border bg-background px-3 py-3 text-base font-sans rounded-md"
                      value={cardHolder}
                      onChange={(e) => setCardHolder(e.target.value)}
                      placeholder="Name on card"
                    />
                  </div>
                  <div>
                    <Label htmlFor="rcpt-cardno" className="text-foreground font-sans text-sm">
                      Card number
                    </Label>
                    <input
                      id="rcpt-cardno"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      className="mt-1 w-full border border-border bg-background px-3 py-3 text-base font-sans rounded-md"
                      value={cardNo}
                      onChange={(e) => setCardNo(e.target.value)}
                      placeholder="1234 5678 9012 3456"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="rcpt-expiry" className="text-foreground font-sans text-sm">
                        Expiry (MM/YY)
                      </Label>
                      <input
                        id="rcpt-expiry"
                        autoComplete="cc-exp"
                        className="mt-1 w-full border border-border bg-background px-3 py-3 text-base font-sans rounded-md"
                        value={expiryMmYy}
                        onChange={(e) => setExpiryMmYy(e.target.value)}
                        placeholder="MM/YY"
                      />
                    </div>
                    <div>
                      <Label htmlFor="rcpt-cvv" className="text-foreground font-sans text-sm">
                        CVV
                      </Label>
                      <input
                        id="rcpt-cvv"
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        className="mt-1 w-full border border-border bg-background px-3 py-3 text-base font-sans rounded-md"
                        value={cvv}
                        onChange={(e) => setCvv(e.target.value)}
                        placeholder="123"
                        maxLength={4}
                      />
                    </div>
                  </div>
                </div>

                {paymentError && (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive font-sans" role="alert">
                      {paymentError}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full border-border font-sans"
                      onClick={() => setPaymentError(null)}
                    >
                      Try again
                    </Button>
                  </div>
                )}

                {paymentSubmitting ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-6">
                    <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin rounded-full" />
                    <p className="text-sm font-sans text-muted-foreground">Processing payment...</p>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button
                      type="button"
                      onClick={submitPayment}
                      className="flex-1 bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6"
                    >
                      Pay {restaurant?.currency || 'N$'}
                      {payableTotal.toFixed(2)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setShowPaymentForm(false)
                        setPaymentError(null)
                      }}
                      className="sm:w-auto border-border font-sans py-6"
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
