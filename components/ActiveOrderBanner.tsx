'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { cn } from '@/lib/utils'
import { getSessionInfo } from '@/lib/session'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { orderPath } from '@/lib/firebase/paths'

/**
 * PART 3: Active Order Banner
 * 
 * Banner shows orders for this TABLE, not browser session.
 * Query: restaurant_id + table_number + status in [new, accepted, preparing, ready] + table_closed = false
 * 
 * This ensures:
 * - Banner appears after tab close
 * - Banner survives refresh
 * - Banner is table-specific
 * - No order leakage to new customers
 */
export function ActiveOrderBanner() {
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()
  const restaurantId = params?.restaurantId as string | undefined
  const tableNumberParam = searchParams?.get('table')

  // Prefer session-tied table number (prevents any stale URL/query from showing wrong table orders).
  const sessionInfo = typeof window !== 'undefined' ? getSessionInfo() : null
  const sessionTableNumber = sessionInfo?.table ? Number(sessionInfo.table) : undefined

  const tableNumber =
    sessionTableNumber && Number.isFinite(sessionTableNumber) && sessionTableNumber > 0
      ? sessionTableNumber
      : tableNumberParam
        ? parseInt(tableNumberParam, 10)
        : undefined
  
  // PART 3: Use table-based active orders hook
  const { activeOrder, loading, error } = useActiveOrders(restaurantId, tableNumber)
  const [lastOrder, setLastOrder] = useState<Record<string, any> | null>(null)
  const [lastOrderLoaded, setLastOrderLoaded] = useState(false)

  useEffect(() => {
    if (!db || !restaurantId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }
    const fromSession = typeof window !== 'undefined' ? sessionStorage.getItem('last_order_id') : null
    const fromReturnKey =
      typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_return_order_id') : null
    const orderId = String(fromSession || fromReturnKey || '').trim()
    if (!orderId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }

    const orderRef = doc(db, orderPath(restaurantId, orderId))
    const unsub = onSnapshot(
      orderRef,
      (snap) => {
        if (!snap.exists()) {
          setLastOrder(null)
          setLastOrderLoaded(true)
          return
        }
        const data = snap.data() as Record<string, any>
        if (tableNumber && Number(data.table_number) !== Number(tableNumber)) {
          setLastOrder(null)
          setLastOrderLoaded(true)
          return
        }
        setLastOrder({ id: snap.id, ...data })
        setLastOrderLoaded(true)
      },
      () => {
        setLastOrder(null)
        setLastOrderLoaded(true)
      }
    )
    return () => unsub()
  }, [restaurantId, tableNumber])
  
  // Debug logging
  if (loading) {
    console.log('🔍 ActiveOrderBanner: Loading active orders...')
  }
  if (error) {
    console.error('❌ ActiveOrderBanner error:', error)
  }
  if (activeOrder) {
    console.log('✅ ActiveOrderBanner: Showing banner for order:', activeOrder.id)
  }

  // Don't show banner if loading, error, or no active order
  if (loading && !lastOrderLoaded) {
    return null // Still loading, don't show yet
  }
  
  if (error) {
    console.error('❌ ActiveOrderBanner error:', error)
    return null
  }
  
  const currentOrder = lastOrder || activeOrder

  if (!currentOrder) {
    // Fallback logging: Banner hidden because no active orders found
    console.log('🔍 Banner hidden: No active orders found for this session.')
    return null
  }

  const orderNumber = currentOrder.order_number || currentOrder.id.slice(-6).toUpperCase()

  const getStatusInfo = (status: string, paymentStatus: string) => {
    const s = String(status || '').toLowerCase()
    const p = String(paymentStatus || '').toLowerCase()
    if (p === 'pending' && s === 'new') {
      return { text: 'Order received - Awaiting payment', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'cash_pending' && s === 'new') {
      return { text: 'Order received - Pay at counter', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'paid' && s === 'accepted') {
      return { text: 'Order accepted - Being prepared', pulse: true, tone: 'preparing' as const }
    }
    if (p === 'paid' && s === 'preparing') {
      return { text: 'Your order is being prepared', pulse: true, tone: 'preparing' as const }
    }
    if (p === 'paid' && s === 'ready') {
      return { text: 'Your order is ready for collection', pulse: false, tone: 'ready' as const }
    }
    if (p === 'paid' && s === 'completed') {
      return { text: 'Payment confirmed - Thank you!', pulse: false, tone: 'completed' as const }
    }
    return { text: 'Order in progress', pulse: false, tone: 'neutral' as const }
  }

  const statusInfo = getStatusInfo(currentOrder.status, currentOrder.payment_status)

  const handleClick = () => {
    // Cross-Device Receipt: Route to table-based receipt page instead of order-specific confirmation
    // This ensures any device at the table can see all orders, not just the specific order ID
    if (restaurantId && tableNumber) {
      router.push(`/menu/${restaurantId}/receipt?table=${tableNumber}`)
    } else {
      // Fallback: If restaurantId or tableNumber is missing, try order confirmation
      console.warn('⚠️ Missing restaurantId or tableNumber, falling back to order confirmation')
      router.push(`/order-confirmation?orderId=${currentOrder.id}`)
    }
  }

  const toneClass =
    statusInfo.tone === 'preparing'
      ? 'bg-[#FF6B35] text-white border-[#e55a28]'
      : statusInfo.tone === 'ready'
      ? 'bg-green-600 text-white border-green-700'
      : statusInfo.tone === 'completed'
      ? 'bg-muted text-foreground border-border'
      : 'bg-black text-white border-border'

  return (
    <div
      onClick={handleClick}
      className={cn(
        'sticky top-0 z-[60] cursor-pointer transition-all border-b',
        toneClass,
        statusInfo.pulse && 'animate-pulse'
      )}
    >
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <p className="font-semibold text-sm">
                Order #{orderNumber} {statusInfo.text}
              </p>
              <p className="text-xs opacity-90">
                {currentOrder.total && `Total: N$${Number(currentOrder.total).toFixed(2)} • `}
                Tap to view receipt
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-90">View Receipt →</span>
          </div>
        </div>
      </div>
    </div>
  )
}

