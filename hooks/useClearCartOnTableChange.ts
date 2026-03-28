'use client'

import { useEffect, useRef } from 'react'
import { useCart } from '@/contexts/cart-context'

/**
 * Clears the cart when the user switches to a different table (URL ?table=) at the same restaurant.
 * The cart is stored globally in localStorage; without this, items added at Table 3 could be
 * submitted while on a Table 5 link.
 */
export function useClearCartOnTableChange(restaurantId: string | undefined, tableNumber: number) {
  const { clearCart } = useCart()
  const prevRef = useRef<{ rid?: string; table: number } | null>(null)

  useEffect(() => {
    if (!restaurantId) {
      prevRef.current = { rid: restaurantId, table: tableNumber }
      return
    }
    const prev = prevRef.current
    if (
      prev &&
      prev.rid === restaurantId &&
      prev.table > 0 &&
      tableNumber > 0 &&
      prev.table !== tableNumber
    ) {
      clearCart()
    }
    prevRef.current = { rid: restaurantId, table: tableNumber }
  }, [restaurantId, tableNumber, clearCart])
}
