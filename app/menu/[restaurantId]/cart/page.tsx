'use client'

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurantByFirebaseId } from '@/lib/supabase/restaurants'
import { useCart } from '@/contexts/cart-context'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { useTab } from '@/contexts/tab-context'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Edit, Trash2, ShoppingCart, UtensilsCrossed } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { getSupabaseMenuItemById } from '@/lib/supabase/menu'
import { useToast } from '@/hooks/use-toast'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { clearOrderIdempotencyKey, getOrderIdempotencyKey } from '@/lib/order-idempotency'
import { ReadyToPayTabButton, ReadyToPayTabNotified } from '@/components/ready-to-pay-tab'
import { isActiveTabStatus } from '@/lib/tab-session'
import { readStoredTabId } from '@/lib/tab-storage'

type PaymentChoice = 'cash' | 'terminal' | 'online'

function buildPaymentFields(choice: PaymentChoice) {
  if (choice === 'cash') return { paymentMethod: 'cash' as const, paymentChannel: null as null }
  if (choice === 'terminal') return { paymentMethod: 'card' as const, paymentChannel: 'terminal' as const }
  return { paymentMethod: 'card' as const, paymentChannel: 'hosted' as const }
}

export default function CartPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  const tabIdFromUrl = searchParams.get('tabId')?.trim() || ''
  const { toast } = useToast()

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items, updateItem, removeItem, getTotal, clearCart } = useCart()
  const { isInTab, tabId, sessionId, tabStatus, canAddToTab, tabTotal, refreshTab } = useTab()
  const storedTabId = readStoredTabId()
  const effectiveTabId = tabIdFromUrl || tabId || storedTabId || ''
  const inTabFlow = Boolean(isInTab || effectiveTabId)
  const tabReadyToPay = tabStatus === 'ready_to_pay'
  const showReadyToPay = Boolean(
    storedTabId &&
      effectiveTabId &&
      isActiveTabStatus(tabStatus) &&
      items.length > 0
  )
  const [restaurant, setRestaurant] = useState<any>(null)
  const [orderInstructions, setOrderInstructions] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingItem, setEditingItem] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)
  const [paymentChoice, setPaymentChoice] = useState<PaymentChoice>('cash')

  useEffect(() => {
    if (inTabFlow) setPaymentChoice('terminal')
  }, [inTabFlow])

  const menuQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (tableNumber > 0) q.set('table', String(tableNumber))
    if (effectiveTabId) q.set('tabId', effectiveTabId)
    const s = q.toString()
    return s ? `?${s}` : ''
  }, [tableNumber, effectiveTabId])

  useEffect(() => {
    const loadRestaurant = async () => {
      try {
        const restaurantData = await getRestaurantByFirebaseId(restaurantId)
        setRestaurant(restaurantData)
      } catch (err) {
        console.error('Failed to load restaurant:', err)
      } finally {
        setLoading(false)
      }
    }
    
    if (restaurantId) {
      loadRestaurant()
    }
  }, [restaurantId])

  const handleEdit = async (index: number) => {
    const cartItem = items[index]
    try {
      const menuItem = await getSupabaseMenuItemById(cartItem.menu_item_id, restaurantId, true)
      if (menuItem) {
        setEditingItem(menuItem)
        setEditingIndex(index)
      }
    } catch (err) {
      console.error('Failed to load menu item:', err)
    }
  }

  const handleUpdateItem = (updatedCartItem: any) => {
    if (editingIndex !== null) {
      updateItem(editingIndex, updatedCartItem)
      setEditingIndex(null)
      setEditingItem(null)
    }
  }

  const subtotal = getTotal()
  const total = subtotal

  const handleAddToTab = async () => {
    if (paying) return
    if (!inTabFlow || !effectiveTabId) return
    if (tabReadyToPay || !canAddToTab) {
      toast({
        title: 'Tab is ready to pay',
        description: 'You cannot add more items. Ask your waiter for the card machine.',
        variant: 'destructive',
      })
      return
    }
    try {
      setPaying(true)
      console.log('[CART] add to tab', { effectiveTabId, tableNumber, restaurantId })
      const payload = {
        restaurantId: String(restaurantId),
        tableNumber: Number(tableNumber) || 0,
        sessionId: String(sessionId || ''),
        tabId: String(effectiveTabId),
        memberSessionId: String(sessionId || ''),
        items: items.map((item) => ({
          menuItemId: item.menu_item_id,
          name: item.display_name || item.name,
          displayName: item.display_name || item.name,
          quantity: item.quantity,
          basePrice: item.base_price,
          selectedVariants: item.selected_variants || {},
          size: item.selected_size?.name || null,
          addons: item.selected_addons || [],
          specialInstructions: item.special_instructions || '',
          subtotal: item.subtotal,
        })),
        subtotal: Number(subtotal),
        total: Number(total),
        paymentMethod: 'card',
        paymentChannel: null,
        orderInstructions: orderInstructions?.trim() || '',
      }
      const idem = getOrderIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idem ? { 'x-idempotency-key': idem } : {}),
        },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to add to tab')
      console.log('[CART] add to tab success', data)
      clearOrderIdempotencyKey()
      await refreshTab()
      if (typeof window !== 'undefined' && data?.orderId) {
        sessionStorage.setItem('last_order_id', String(data.orderId))
        sessionStorage.setItem('flashtap_return_order_id', String(data.orderId))
        if (tableNumber > 0) sessionStorage.setItem('flashtap_return_table', String(tableNumber))
      }
      clearCart()
      toast({
        title: 'Added to tab!',
        description: 'Keep ordering or settle when ready.',
      })
      router.replace(`/menu/${restaurantId}/browse${menuQuery}`)
    } catch (err: any) {
      toast({
        title: 'Could not add to tab',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setPaying(false)
    }
  }

  const handlePlaceOrder = async () => {
    if (paying) return
    if (inTabFlow) return
    if (paymentChoice === 'online') return
    if (!tableNumber || tableNumber <= 0) {
      toast({
        title: 'Table required',
        description: 'Scan the QR code at your table to place an order.',
        variant: 'destructive',
      })
      return
    }
    let sid = getCurrentSession()
    if (!sid) sid = getOrCreateSession(restaurantId, String(tableNumber))
    if (!sid) {
      toast({ title: 'Session error', description: 'Please try again.', variant: 'destructive' })
      return
    }

    setPaying(true)
    try {
      const { paymentMethod, paymentChannel } = buildPaymentFields(paymentChoice)
      const payload = {
        restaurantId: String(restaurantId),
        tableNumber: Number(tableNumber),
        session_id: String(sid),
        member_session_id: String(sid),
        items: items.map((item) => ({
          menuItemId: item.menu_item_id,
          name: item.display_name || item.name,
          displayName: item.display_name || item.name,
          quantity: item.quantity,
          basePrice: item.base_price,
          selectedVariants: item.selected_variants || {},
          size: item.selected_size?.name || null,
          addons: item.selected_addons || [],
          specialInstructions: item.special_instructions || '',
          subtotal: item.subtotal,
        })),
        subtotal: Number(subtotal),
        total: Number(total),
        paymentMethod,
        paymentChannel,
        orderInstructions: orderInstructions?.trim() || '',
      }
      const idem = getOrderIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idem ? { 'x-idempotency-key': idem } : {}),
        },
        body: JSON.stringify(JSON.parse(JSON.stringify(payload))),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to place order')

      const orderId = data?.orderId as string | undefined
      if (!orderId) throw new Error('No order ID returned')

      clearOrderIdempotencyKey()
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('last_order_id', String(orderId))
        sessionStorage.setItem('flashtap_return_order_id', String(orderId))
        sessionStorage.setItem('flashtap_return_table', String(tableNumber))
      }
      clearCart()

      const confirmQs = new URLSearchParams()
      if (tableNumber > 0) confirmQs.set('table', String(tableNumber))
      if (paymentChoice === 'terminal') confirmQs.set('notice', 'terminal')
      const confirmSuffix = confirmQs.toString() ? `?${confirmQs.toString()}` : ''
      router.replace(`/menu/${restaurantId}/order-confirmation/${orderId}${confirmSuffix}`)
    } catch (err: unknown) {
      toast({
        title: 'Order failed',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setPaying(false)
    }
  }

  const handleProceedCheckout = () => {
    if (paying) return
    setPaying(true)
    const qs = tableNumber > 0 ? `?table=${tableNumber}` : ''
    router.push(`/menu/${restaurantId}/order-secure${qs}`)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  // Empty cart state
  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-8">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
            </Button>
            <h1 className="text-2xl font-serif font-bold text-foreground">Your Order</h1>
          </div>
          
          {/* Empty State */}
          <div className="bg-card border border-border p-16 text-center">
            <ShoppingCart className="w-16 h-16 text-muted-foreground mx-auto mb-6" />
            <h2 className="text-xl font-serif font-bold text-foreground mb-2">Your cart is empty</h2>
            <p className="text-muted-foreground font-sans mb-8">Add some items to get started!</p>
            <Link href={`/menu/${restaurantId}/browse${menuQuery}`}>
              <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans px-8">
                Browse Menu
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
          </Button>
          <h1 className="text-2xl font-serif font-bold text-foreground">Your Order</h1>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Cart Items */}
          <div className="space-y-4 lg:col-span-2">
            {items.map((item, index) => (
              <div
                key={index}
                className="max-w-full overflow-hidden bg-card border border-border p-4"
              >
                <div className="flex gap-4">
                  {/* Image */}
                  <div className="relative h-[76px] w-[76px] flex-shrink-0 overflow-hidden bg-muted">
                    {item.image_url ? (
                      <Image
                        src={item.image_url}
                        alt={item.name}
                        fill
                        loading="lazy"
                        className="object-cover"
                        unoptimized
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                          const container = e.currentTarget.closest('.relative')
                          const placeholder = container?.querySelector('.image-placeholder')
                          if (placeholder) placeholder.classList.remove('hidden')
                        }}
                      />
                    ) : null}
                    <div className={`image-placeholder absolute inset-0 flex items-center justify-center bg-muted ${item.image_url ? 'hidden' : ''}`}>
                      <UtensilsCrossed className="w-8 h-8 text-muted-foreground" />
                    </div>
                  </div>
                  
                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-1 break-words font-sans text-base font-semibold text-foreground">
                      {item.display_name || item.name}
                    </h3>
                    {item.selected_size && (
                      <p className="font-sans text-sm text-muted-foreground">
                        Size: {item.selected_size.name}
                      </p>
                    )}
                    {item.selected_addons.length > 0 && (
                      <p className="break-words font-sans text-sm text-muted-foreground">
                        Add-ons: {item.selected_addons.map(a => a.name).join(', ')}
                      </p>
                    )}
                    {item.special_instructions && (
                      <p className="mt-1 break-words font-sans text-sm italic text-muted-foreground">
                        "{item.special_instructions}"
                      </p>
                    )}
                    
                    {/* Price + Actions */}
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="font-sans text-base font-bold text-foreground sm:text-lg">
                        <span className="mr-0.5 text-xs font-normal text-muted-foreground sm:text-sm">
                          {restaurant?.currency || 'N$'}
                        </span>
                        {item.subtotal.toFixed(2)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (×{item.quantity})
                        </span>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(index)}
                            className="h-9 border-border px-3 font-sans text-sm"
                          >
                            <Edit className="mr-1 h-4 w-4 stroke-[1.5]" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => removeItem(index)}
                            className="h-9 border-border px-3 font-sans text-sm text-destructive hover:text-destructive"
                          >
                            <Trash2 className="mr-1 h-4 w-4 stroke-[1.5]" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Order Summary */}
          <div className="w-full max-w-full lg:col-span-1">
            <div className="w-full max-w-full bg-card border border-border p-4 sm:p-6 lg:sticky lg:top-4">
              <h2 className="mb-6 font-serif text-xl font-bold text-foreground">Order Summary</h2>
              
              {/* Totals */}
              <div className="mb-6 space-y-3">
                <div className="flex justify-between font-sans text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="text-foreground">{restaurant?.currency || 'N$'}{subtotal.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="mb-6 border-t border-border pt-4">
                <div className="flex justify-between items-center">
                  <span className="font-sans text-lg font-semibold text-foreground">Total</span>
                  <span className="font-sans text-2xl font-bold text-foreground">
                    {restaurant?.currency || 'N$'}{total.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Order Instructions */}
              <div className="mb-6">
                <Label htmlFor="instructions" className="mb-2 block font-sans text-base text-foreground">
                  Order Instructions (Optional)
                </Label>
                <Textarea
                  id="instructions"
                  placeholder="Any special requests for your order?"
                  value={orderInstructions}
                  onChange={(e) => setOrderInstructions(e.target.value)}
                  rows={3}
                  className="w-full max-w-full font-sans border-border text-sm sm:text-base"
                />
              </div>

              {inTabFlow && (
                <div className="mb-6 rounded-lg border border-border bg-muted/30 p-4">
                  <p className="font-sans text-sm font-semibold text-foreground">Card payment only</p>
                  <p className="mt-2 font-sans text-sm text-muted-foreground">
                    Card — Waiter brings card machine to your table
                  </p>
                  {tabTotal > 0 && (
                    <p className="mt-3 font-sans text-sm text-foreground">
                      Tab total so far: {restaurant?.currency || 'N$'}
                      {tabTotal.toFixed(2)}
                    </p>
                  )}
                  {tabReadyToPay && (
                    <p className="mt-3 font-sans text-sm text-amber-700 dark:text-amber-400">
                      This tab is ready to pay — you cannot add more items.
                    </p>
                  )}
                </div>
              )}

              {!inTabFlow && (
                <div className="mb-6" role="radiogroup" aria-label="Payment method">
                  <Label className="mb-3 block font-sans text-base font-semibold text-foreground">
                    How would you like to pay?
                  </Label>
                  <div className="grid gap-3">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={paymentChoice === 'cash'}
                      onClick={() => setPaymentChoice('cash')}
                      disabled={paying}
                      className={cn(
                        'rounded-lg border-2 p-4 text-left transition-colors font-sans',
                        paymentChoice === 'cash'
                          ? 'border-foreground bg-muted/50'
                          : 'border-border bg-background hover:border-muted-foreground/40',
                        paying && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="text-lg" aria-hidden>
                        💵
                      </span>
                      <span className="ml-2 font-semibold text-foreground">Cash</span>
                      <p className="mt-1 text-sm text-muted-foreground">Pay at the table</p>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={paymentChoice === 'terminal'}
                      onClick={() => setPaymentChoice('terminal')}
                      disabled={paying}
                      className={cn(
                        'rounded-lg border-2 p-4 text-left transition-colors font-sans',
                        paymentChoice === 'terminal'
                          ? 'border-foreground bg-muted/50'
                          : 'border-border bg-background hover:border-muted-foreground/40',
                        paying && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="text-lg" aria-hidden>
                        💳
                      </span>
                      <span className="ml-2 font-semibold text-foreground">Card</span>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Waiter brings card machine to your table
                      </p>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={paymentChoice === 'online'}
                      onClick={() => setPaymentChoice('online')}
                      disabled={paying}
                      className={cn(
                        'rounded-lg border-2 p-4 text-left transition-colors font-sans',
                        paymentChoice === 'online'
                          ? 'border-foreground bg-muted/50'
                          : 'border-border bg-background hover:border-muted-foreground/40',
                        paying && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="text-lg" aria-hidden>
                        🌐
                      </span>
                      <span className="ml-2 font-semibold text-foreground">Online</span>
                      <p className="mt-1 text-sm text-muted-foreground">Pay now online</p>
                    </button>
                  </div>
                </div>
              )}

              {/* Main CTA: tab = always POST; non-tab online = order-secure; non-tab cash/card = POST from cart */}
              {showReadyToPay && (
                <div className="mb-4">
                  {tabReadyToPay ? (
                    <ReadyToPayTabNotified />
                  ) : (
                    <ReadyToPayTabButton
                      tabId={effectiveTabId}
                      restaurantId={restaurantId}
                      onSuccess={() => void refreshTab()}
                    />
                  )}
                </div>
              )}

              {inTabFlow ? (
                <Button
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
                  size="lg"
                  onClick={handleAddToTab}
                  disabled={paying || tabReadyToPay || !canAddToTab}
                >
                  {paying ? 'Adding…' : 'Add to Tab'}
                </Button>
              ) : paymentChoice === 'online' ? (
                <Button
                  type="button"
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base disabled:opacity-50 disabled:cursor-not-allowed"
                  size="lg"
                  onClick={handleProceedCheckout}
                  disabled={paying}
                >
                  {paying ? 'Opening…' : 'Proceed to Checkout'}
                </Button>
              ) : (
                <Button
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base disabled:opacity-50 disabled:cursor-not-allowed"
                  size="lg"
                  onClick={handlePlaceOrder}
                  disabled={paying}
                >
                  {paying ? 'Placing order…' : 'Place order'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Edit Item Modal */}
      {editingItem && editingIndex !== null && (
        <ItemDetailModal
          item={editingItem}
          restaurant={restaurant}
          onClose={() => {
            setEditingItem(null)
            setEditingIndex(null)
          }}
          onAddToCart={handleUpdateItem}
        />
      )}
    </div>
  )
}
