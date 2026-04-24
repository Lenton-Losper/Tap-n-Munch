'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { cn } from '@/lib/utils'
import { getSessionInfo, getCurrentSession } from '@/lib/session'
import { ReadyToPayTerminalButton } from '@/components/ready-to-pay-terminal'
import { supabase } from '@/lib/supabase/client'

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
  const persistedOrderId =
    typeof window !== 'undefined'
      ? String(
          sessionStorage.getItem('last_order_id') || sessionStorage.getItem('flashtap_return_order_id') || ''
        ).trim()
      : ''

  useEffect(() => {
    if (!restaurantId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }
    const orderId = persistedOrderId
    if (!orderId) {
      setLastOrder(null)
      setLastOrderLoaded(true)
      return
    }

    let cancelled = false

    const fetchLastOrder = async () => {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .single()
      if (cancelled) return
      if (!data) {
        setLastOrder(null)
        setLastOrderLoaded(true)
        return
      }
      if (tableNumber && Number(data.table_number) !== Number(tableNumber)) {
        setLastOrder(null)
        setLastOrderLoaded(true)
        return
      }
      setLastOrder({ id: String(data.id), ...data })
      setLastOrderLoaded(true)
    }

    fetchLastOrder().catch(() => {
      if (!cancelled) {
        setLastOrder(null)
        setLastOrderLoaded(true)
      }
    })

    const channel = supabase
      .channel(`active-banner-last-order-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        () => {
          fetchLastOrder().catch(() => {
            // no-op: handled in fetchLastOrder
          })
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [restaurantId, tableNumber, persistedOrderId])
  
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

  const payChannel = String(currentOrder.payment_channel || '').toLowerCase()

  const getStatusInfo = (status: string, paymentStatus: string, channel: string) => {
    const s = String(status || '').toLowerCase()
    const p = String(paymentStatus || '').toLowerCase()
    const ch = String(channel || '').toLowerCase()
    if (p === 'pending' && s === 'new' && ch === 'terminal') {
      return { text: 'Order received — tap below when ready for card machine', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'pending' && s === 'new') {
      return { text: 'Order received - Awaiting payment', pulse: true, tone: 'neutral' as const }
    }
    if (p === 'pending' && s === 'ready_for_terminal') {
      return { text: 'Waiter notified — card machine on the way', pulse: true, tone: 'preparing' as const }
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

  const statusInfo = getStatusInfo(currentOrder.status, currentOrder.payment_status, payChannel)

  const showReadyToPayTerminal =
    payChannel === 'terminal' &&
    String(currentOrder.payment_status || '').toLowerCase() === 'pending' &&
    String(currentOrder.status || '').toLowerCase() !== 'ready_for_terminal' &&
    String(currentOrder.status || '').toLowerCase() !== 'completed'

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
      className={cn(
        'sticky top-0 z-[60] transition-all border-b',
        toneClass,
        statusInfo.pulse && 'animate-pulse'
      )}
    >
      <div className="container mx-auto px-4 py-3 space-y-3">
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleClick()
            }
          }}
          className="flex cursor-pointer items-center justify-between"
        >
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
        {showReadyToPayTerminal && restaurantId && (
          <div onClick={(e) => e.stopPropagation()} className="pb-1">
            <ReadyToPayTerminalButton
              restaurantId={restaurantId}
              orderId={String(currentOrder.id)}
              tableNumber={Number(currentOrder.table_number) || Number(tableNumber) || 0}
              sessionId={getCurrentSession()}
              className="[&_button]:bg-white [&_button]:text-black [&_button]:hover:bg-white/90"
            />
          </div>
        )}
      </div>
    </div>
  )
}

