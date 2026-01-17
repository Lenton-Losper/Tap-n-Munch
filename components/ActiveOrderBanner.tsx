'use client'

import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { useActiveOrders } from '@/hooks/useActiveOrders'
import { cn } from '@/lib/utils'

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
  const tableNumber = tableNumberParam ? parseInt(tableNumberParam, 10) : undefined
  
  // PART 3: Use table-based active orders hook
  const { activeOrder, loading, error } = useActiveOrders(restaurantId, tableNumber)
  
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
  if (loading) {
    return null // Still loading, don't show yet
  }
  
  if (error) {
    console.error('❌ ActiveOrderBanner error:', error)
    return null
  }
  
  if (!activeOrder) {
    // Fallback logging: Banner hidden because no active orders found
    console.log('🔍 Banner hidden: No active orders found for this session.')
    return null
  }

  const orderNumber = activeOrder.order_number || activeOrder.id.slice(-6).toUpperCase()

  // PART 2: Standardize Order Status Model
  // Get status emoji and text
  const getStatusInfo = (status: string) => {
    switch (status) {
      case 'new':
        return { emoji: '🎉', text: 'Order received', pulse: true }
      case 'accepted':
        return { emoji: '👨‍🍳', text: 'Order accepted', pulse: true }
      case 'preparing':
        return { emoji: '🔥', text: 'Being prepared', pulse: true }
      case 'ready':
        return { emoji: '✅', text: 'Order ready!', pulse: false }
      default:
        return { emoji: '📋', text: 'Order in progress', pulse: false }
    }
  }

  const statusInfo = getStatusInfo(activeOrder.status)

  const handleClick = () => {
    // Cross-Device Receipt: Route to table-based receipt page instead of order-specific confirmation
    // This ensures any device at the table can see all orders, not just the specific order ID
    if (restaurantId && tableNumber) {
      router.push(`/menu/${restaurantId}/receipt?table=${tableNumber}`)
    } else {
      // Fallback: If restaurantId or tableNumber is missing, try order confirmation
      console.warn('⚠️ Missing restaurantId or tableNumber, falling back to order confirmation')
      router.push(`/order-confirmation?orderId=${activeOrder.id}`)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={cn(
        'sticky top-0 z-[60] bg-black text-white cursor-pointer transition-all border-b border-border',
        statusInfo.pulse && 'animate-pulse'
      )}
    >
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{statusInfo.emoji}</span>
            <div>
              <p className="font-semibold text-sm">
                Order #{orderNumber} {statusInfo.text}
              </p>
              <p className="text-xs opacity-90">
                {activeOrder.total && `Total: N$${activeOrder.total.toFixed(2)} • `}
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

