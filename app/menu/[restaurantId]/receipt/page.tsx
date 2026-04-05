'use client'

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { collection, query, where, onSnapshot, limit } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { getCurrentSession, getSessionInfo } from '@/lib/session'

const RECEIPT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

function placedAtMillis(order: { placed_at?: unknown }): number {
  const p = order?.placed_at as { toMillis?: () => number } | number | undefined
  if (p && typeof p === 'object' && typeof (p as { toMillis?: () => number }).toMillis === 'function') {
    return (p as { toMillis: () => number }).toMillis()
  }
  if (typeof p === 'number' && Number.isFinite(p)) return p
  return 0
}

/**
 * Current QR session: orders with `session_id` must match. Legacy orders without `session_id`
 * only count if placed within the last 7 days (avoids ancient table history).
 * Cancelled-status filter temporarily disabled for debugging visibility.
 */
function isOrderInActiveReceiptSession(
  order: { session_id?: unknown; placed_at?: unknown },
  clientSessionId: string | null,
  nowMs: number
): boolean {
  const sidRaw = order.session_id
  const hasSessionField =
    sidRaw != null && String(sidRaw).trim() !== '' && String(sidRaw).trim() !== 'null'

  if (hasSessionField) {
    if (!clientSessionId) return false
    return String(sidRaw) === clientSessionId
  }

  const placed = placedAtMillis(order)
  if (!placed) return false
  return placed >= nowMs - RECEIPT_LOOKBACK_MS
}

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
  const tableNumberFromUrl = searchParams.get('table') || ''

  // Prefer the session's table number (prevents stale URL from showing the wrong table).
  const sessionInfo = typeof window !== 'undefined' ? getSessionInfo() : null
  const sessionTableNumber = sessionInfo?.table ? Number(sessionInfo.table) : null
  const tableNumber = sessionTableNumber && Number.isFinite(sessionTableNumber) && sessionTableNumber > 0 ? String(sessionTableNumber) : tableNumberFromUrl
  /** Re-subscribe when QR session changes so receipt list matches current session */
  const sessionIdKey = typeof window !== 'undefined' ? getCurrentSession() ?? '' : ''
  
  const [orders, setOrders] = useState<any[]>([])
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentSubmitting, setPaymentSubmitting] = useState(false)
  const [paymentSuccess, setPaymentSuccess] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [reconcileStartedAt] = useState(() => Date.now())

  useEffect(() => {
    if (!restaurantId) return
    getRestaurant(restaurantId)
      .then((restaurantData) => setRestaurant(restaurantData))
      .catch((err) => console.error('Failed to load restaurant:', err))
  }, [restaurantId])

  useEffect(() => {
    const tableNum = tableNumber ? Number(tableNumber) : null
    // Prevent stale orders from a previous table render.
    setOrders([])

    if (!tableNum || tableNum <= 0) {
      setLoading(false)
      return
    }

    if (!db || !restaurantId) {
      setLoading(false)
      return
    }

    // Firestore: table + open orders only. Session + 7d legacy rules applied client-side.
    const { ordersPath } = require('@/lib/firebase/paths')
    const ordersRef = collection(db, ordersPath(restaurantId))

    const q = query(
      ordersRef,
      where('table_number', '==', tableNum),
      where('is_closed', '==', false),
      limit(100)
    )

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const clientSessionId = typeof window !== 'undefined' ? getCurrentSession() : null
        const nowMs = Date.now()
        const ordersList = snapshot.docs
          .map((doc) => ({ id: doc.id, ...doc.data() }))
          .filter((order: { table_number?: unknown }) => Number(order.table_number) === tableNum)
          .filter((order) => isOrderInActiveReceiptSession(order, clientSessionId, nowMs))
          .sort((a, b) => placedAtMillis(b) - placedAtMillis(a))
        setOrders(ordersList)
        setLoading(false)
      },
      (error: any) => {
        console.error('Error loading receipt:', error)
        if (error?.code === 'permission-denied') {
          setOrders([])
        }
        setLoading(false)
      }
    )

    return () => unsubscribe()
  }, [restaurantId, tableNumber, sessionIdKey])

  const tableNum = tableNumber ? Number(tableNumber) : null

  const total = useMemo(
    () => (Array.isArray(orders) ? orders.reduce((sum, order) => sum + (order?.total || 0), 0) : 0),
    [orders]
  )
  const unpaidOrders = useMemo(
    () => (Array.isArray(orders) ? orders.filter((o) => o && o.payment_status !== 'paid') : []),
    [orders]
  )
  const payableTotal = useMemo(
    () => unpaidOrders.reduce((sum, order) => sum + (Number(order?.total) || 0), 0),
    [unpaidOrders]
  )
  const allPaid = useMemo(
    () => Array.isArray(orders) && orders.length > 0 && unpaidOrders.length === 0,
    [orders, unpaidOrders]
  )

  // Reconcile card payments (must run every render path — hooks before any return)
  useEffect(() => {
    if (!restaurantId || unpaidOrders.length === 0) return
    const hasCardPending = unpaidOrders.some((o) => o?.payment_method === 'card')
    if (!hasCardPending) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const FIRST_WINDOW_MS = 60_000
    const SECOND_WINDOW_MS = 15 * 60_000

    const run = async () => {
      if (cancelled) return
      const elapsed = Date.now() - reconcileStartedAt
      if (elapsed > SECOND_WINDOW_MS) return
      const cardOrderIds = unpaidOrders
        .filter((o) => o?.payment_method === 'card')
        .map((o) => String(o.id))
        .filter(Boolean)
        .sort()
      if (!cardOrderIds.length) return

      try {
        await fetch('/api/payments/reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantId,
            orderIds: cardOrderIds,
            merchantOrderNo: `${restaurantId}:receipt:${cardOrderIds.join(',')}`,
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
  }, [restaurantId, unpaidOrders, reconcileStartedAt])

  useEffect(() => {
    if (allPaid && (paymentSubmitting || showPaymentForm)) {
      setPaymentSuccess(true)
      setPaymentSubmitting(false)
      setShowPaymentForm(false)
      setPaymentError(null)
    }
  }, [allPaid, paymentSubmitting, showPaymentForm])

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

  const submitPayment = async () => {
    setPaymentError(null)
    const tableNum = tableNumber ? Number(tableNumber) : 0
    if (!restaurantId || !tableNum) {
      setPaymentError('Missing table or restaurant.')
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
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Payment failed (${res.status})`)
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl
        return
      }
      throw new Error('Hosted checkout URL was not returned')
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
                Proceed to Payment — {restaurant?.currency || 'N$'}
                {payableTotal.toFixed(2)}
              </Button>
            ) : (
              <div className="bg-card border border-border p-5 sm:p-6 space-y-4">
                <h2 className="text-lg font-serif font-bold text-foreground">Proceed to PayCloud</h2>
                <p className="text-sm text-muted-foreground font-sans">
                  You will be redirected to PayCloud Hosted Checkout to enter your card details securely.
                </p>
                <p className="text-sm text-muted-foreground font-sans">
                  Total due:{' '}
                  <span className="font-semibold text-foreground">
                    {restaurant?.currency || 'N$'}
                    {payableTotal.toFixed(2)}
                  </span>
                </p>

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
                      Proceed to Payment {restaurant?.currency || 'N$'}
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
