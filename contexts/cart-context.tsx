'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'
import { getCurrentSession } from '@/lib/session'
import { findMergeableLineIndex } from '@/lib/cart/cart-line-identity'
import { round2 } from '@/lib/tax-rates/apply-tax'

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
  addItem: (item: CartItem) => void
  updateItem: (index: number, item: CartItem) => void
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
   * Adds a line, merging into an identical one when there is one (issue #133).
   *
   * "Identical" is decided by cartLineIdentity, which keys on everything the customer sees on
   * the line -- item, size, variants, add-ons, note and unit price -- so two different sizes
   * still produce two lines. See lib/cart/cart-line-identity.ts.
   *
   * Money is summed from the two lines' own subtotals rather than recomputed, so a merged line
   * always costs exactly what the two separate lines cost, then rounded to cents so repeated
   * merges cannot accumulate floating-point residue.
   */
  const addItem = (item: CartItem) => {
    setItems(prev => {
      const index = findMergeableLineIndex(prev, item)
      if (index === -1) return [...prev, item]

      const existing = prev[index]
      const merged: CartItem = {
        ...existing,
        quantity: existing.quantity + item.quantity,
        subtotal: round2(existing.subtotal + item.subtotal),
      }
      const next = [...prev]
      next[index] = merged
      return next
    })
  }

  const updateItem = (index: number, item: CartItem) => {
    setItems(prev => {
      const updated = [...prev]
      updated[index] = item
      return updated
    })
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
