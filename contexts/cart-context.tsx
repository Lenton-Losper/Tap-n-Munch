'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'
import { getCurrentSession } from '@/lib/session'
import { capCartLine } from '@/lib/cart/cart-lines'

export interface CartItem {
  menu_item_id: string
  name: string
  display_name?: string
  quantity: number
  base_price: number
  selected_size: { name: string; price_modifier: number } | null
  selected_addons: { name: string; price: number }[]
  selected_variants?: Record<string, string>
  special_instructions: string
  subtotal: number
  image_url?: string
}

interface CartContextType {
  items: CartItem[]
  /** Adds a line, capped at MAX_LINE_QUANTITY. `clamped` reports whether it had to be. */
  addItem: (item: CartItem) => { clamped: boolean }
  updateItem: (index: number, item: CartItem) => void
  /** Replace the whole line list -- for edits that change the shape of the cart, not one row. */
  replaceItems: (items: CartItem[]) => void
  removeItem: (index: number) => void
  clearCart: () => void
  getTotal: () => number
  getItemCount: () => number
}

const CartContext = createContext<CartContextType | undefined>(undefined)

function hydrateCartFromStorage(): CartItem[] {
  if (typeof window === 'undefined') return []
  const sessionId = getCurrentSession()
  const saved = localStorage.getItem('cart')
  const savedSessionId = localStorage.getItem('cart_session_id')

  if (saved && sessionId && savedSessionId === sessionId) {
    try {
      return JSON.parse(saved) as CartItem[]
    } catch (e) {
      console.error('Failed to load cart from localStorage', e)
    }
  }

  localStorage.removeItem('cart')
  localStorage.removeItem('cart_session_id')
  return []
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(hydrateCartFromStorage)

  // Save cart to localStorage whenever it changes
  useEffect(() => {
    const sessionId = getCurrentSession()
    if (!sessionId) return
    localStorage.setItem('cart', JSON.stringify(items))
    localStorage.setItem('cart_session_id', sessionId)
  }, [items])

  /**
   * Adds a line, capped at MAX_LINE_QUANTITY.
   *
   * The server refuses an over-cap line at submit (app/api/orders/route.ts, via
   * validateOrderQuantities), so a customer must not be able to build one here and be told
   * about it only after they have finished choosing. capCartLine owns the cap and the
   * repricing that has to go with it; see it for why the callers' own limits are not enough.
   *
   * The cap depends only on the incoming line, so it is applied before the state update and
   * the append stays a functional update -- two adds in flight must not read the same `items`
   * and lose one.
   *
   * Returns whether the line was capped, so a caller can tell the customer. Nothing surfaces
   * it yet: no current caller can pass an over-cap quantity, so the copy would be unreachable.
   */
  const addItem = (item: CartItem): { clamped: boolean } => {
    const { line, clamped } = capCartLine(item)
    setItems(prev => [...prev, line])
    return { clamped }
  }

  const updateItem = (index: number, item: CartItem) => {
    setItems(prev => {
      const updated = [...prev]
      updated[index] = item
      return updated
    })
  }

  const replaceItems = (next: CartItem[]) => {
    setItems(next)
  }

  const removeItem = (index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const clearCart = () => {
    setItems([])
    localStorage.removeItem('cart')
    localStorage.removeItem('cart_session_id')
  }

  const getTotal = () => {
    return items.reduce((sum, item) => sum + item.subtotal, 0)
  }

  const getItemCount = () => {
    return items.reduce((sum, item) => sum + item.quantity, 0)
  }

  return (
    <CartContext.Provider
      value={{
        items,
        addItem,
        updateItem,
        replaceItems,
        removeItem,
        clearCart,
        getTotal,
        getItemCount,
      }}
    >
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const context = useContext(CartContext)
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider')
  }
  return context
}
