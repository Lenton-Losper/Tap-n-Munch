'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { useCart, type CartItem } from '@/contexts/cart-context'
import { applyCartLineEdit } from '@/lib/cart/cart-lines'
import { MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { useTab } from '@/contexts/tab-context'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Edit, Trash2, ShoppingCart, UtensilsCrossed } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { CartItemNote } from '@/components/menu/cart-item-note'
import { getSupabaseMenuItemById } from '@/lib/supabase/menu'
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/client'
import { useToast } from '@/hooks/use-toast'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { clearCartIdempotencyKey, getOrCreateCartIdempotencyKey } from '@/lib/idempotency'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'
import { clearTabSession, readStoredTabId } from '@/lib/tab-storage'
import { useTabSessionEndedRedirect } from '@/hooks/useTabSessionEndedRedirect'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import { isKioskMode, getKioskName, kioskSuccessPath } from '@/lib/kiosk'
import { CART_COPY } from '@/lib/cart/cart-copy'
import { CUSTOMER_NAV_COPY } from '@/lib/customer-nav-copy'
import { ORDER_PLACED_PARAM } from '@/lib/customer-copy/qr-redesign-copy'
import { customerSafeError } from '@/lib/customer-copy/customer-safe-error'

type PaymentChoice = 'cash' | 'card_manual' | 'other' | 'online'

/** Set to true to show Finatic hosted "Online (card)" checkout on the cart page. */
const ENABLE_ONLINE_CARD_CHECKOUT = false

function buildPaymentFields(choice: PaymentChoice) {
  if (choice === 'cash') return { paymentMethod: 'cash' as const, paymentChannel: 'cash' as const }
  if (choice === 'card_manual') return { paymentMethod: 'card' as const, paymentChannel: 'card_manual' as const }
  if (choice === 'other') return { paymentMethod: 'other' as const, paymentChannel: 'other' as const }
  return { paymentMethod: 'card' as const, paymentChannel: 'hosted' as const }
}

export default function CartPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  const tabIdFromUrl = searchParams.get('tabId')?.trim() || ''
  const isKiosk = isKioskMode(searchParams)
  const kioskCustomerName = getKioskName(searchParams)
  const { toast } = useToast()
  const { restaurant, settings, currency, paymentMethods: enabledMethods, kioskPaymentMethods, permissions, loading: restaurantLoading } =
    useRestaurant()

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items, updateItem, replaceItems, removeItem, getTotal, clearCart } = useCart()
  const { isInTab, tabId, sessionId, tabStatus, refreshTab } = useTab()
  const storedTabId = readStoredTabId()
  const effectiveTabId = tabIdFromUrl || tabId || storedTabId || ''
  const { redirecting: tabSessionRedirecting } = useTabSessionEndedRedirect({
    restaurantId,
    tableNumber,
    tabId: effectiveTabId || null,
    tabStatus,
    enabled: Boolean(effectiveTabId),
    onSessionEnded: () => clearCart(),
  })
  const inTabFlow = Boolean(isInTab || effectiveTabId)
  const tabReadyToPay = tabStatus === 'ready_to_pay'
  const [hasSessionTabOrders, setHasSessionTabOrders] = useState(false)
  const [orderInstructions, setOrderInstructions] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingItem, setEditingItem] = useState<any>(null)
  const [paying, setPaying] = useState(false)
  const [paymentChoice, setPaymentChoice] = useState<PaymentChoice>('cash')

  useEffect(() => {
    let cancelled = false

    const runOrderChecks = async () => {
      const sessionOrdersPromise =
        effectiveTabId && sessionId && restaurantId
          ? fetchGuestOrdersBySession({
              restaurantId,
              sessionId,
              tabId: effectiveTabId,
              countOnly: true,
            })
          : null

      const staleTabOrdersPromise =
        tabReadyToPay && storedTabId && effectiveTabId && restaurantId
          ? fetchGuestOrdersBySession({
              restaurantId,
              tabId: effectiveTabId,
              countOnly: true,
            })
          : null

      const [sessionResult, staleTabResult] = await Promise.all([
        sessionOrdersPromise ?? Promise.resolve({ count: 0, orders: [] }),
        staleTabOrdersPromise ?? Promise.resolve({ count: 0, orders: [] }),
      ])

      if (cancelled) return

      if (sessionOrdersPromise) {
        setHasSessionTabOrders(Number(sessionResult.count || 0) > 0)
      } else {
        setHasSessionTabOrders(false)
      }

      const hasSessionOrders =
        sessionOrdersPromise ? Number(sessionResult.count || 0) > 0 : false

      if (
        !tabReadyToPay ||
        hasSessionOrders ||
        !storedTabId ||
        !effectiveTabId ||
        !restaurantId ||
        !staleTabOrdersPromise
      ) {
        return
      }

      if ((staleTabResult.count || 0) === 0) {
        clearTabSession()
        const q = new URLSearchParams()
        if (tableNumber > 0) q.set('table', String(tableNumber))
        router.replace(`/menu/${restaurantId}/browse${q.toString() ? `?${q.toString()}` : ''}`)
      }
    }

    void runOrderChecks()
    return () => {
      cancelled = true
    }
  }, [
    effectiveTabId,
    sessionId,
    restaurantId,
    tabReadyToPay,
    storedTabId,
    tableNumber,
    router,
  ])

  const menuQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (tableNumber > 0) q.set('table', String(tableNumber))
    if (effectiveTabId) q.set('tabId', effectiveTabId)
    if (isKiosk) q.set('kiosk', 'true')
    if (kioskCustomerName) q.set('name', kioskCustomerName)
    const s = q.toString()
    return s ? `?${s}` : ''
  }, [tableNumber, effectiveTabId, isKiosk, kioskCustomerName])

  /**
   * Where Place Order goes on the tab path (spec section 16).
   *
   * `tabId` is deliberately NOT carried: My Orders reads the tab through TabProvider, and
   * `tab-context` adopts any `?tabId=` in the URL into localStorage without validating it
   * (audit section 18, tab-context.tsx). Passing one where the destination does not need one
   * widens that surface for no benefit.
   */
  const myOrdersPlacedQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (tableNumber > 0) q.set('table', String(tableNumber))
    q.set(ORDER_PLACED_PARAM, '1')
    return `?${q.toString()}`
  }, [tableNumber])

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

  /**
   * The one way an edited line goes back into the cart.
   *
   * An edit can turn this line into a copy of another one; applyCartLineEdit folds those
   * together rather than leaving the customer two rows they cannot tell apart. Every edit
   * path has to come through here -- the per-item note used to write its slot with
   * updateItem() alone, which is the second route to that duplicate state (#133 residual).
   */
  const commitLineEdit = (index: number, updatedCartItem: CartItem) => {
    const result = applyCartLineEdit(items, index, updatedCartItem)
    replaceItems(result.items)

    /*
     * Every outcome the customer can see has to say something. A refused fold used to say
     * nothing at all: it looks identical to "collided with nothing", so the customer got two
     * rows they cannot tell apart and no reason why. Refusals are reported first because they
     * are the surprising outcome -- the cart did not do what pressing Save looked like it
     * would. A capped line and a refused fold cannot both happen from this screen (the modal
     * cannot emit an over-cap quantity), so the order between them is a formality, not a
     * dropped message.
     */
    if (result.refusedBecause === 'cap') {
      toast({
        title: 'Kept separate — maximum per item',
        description: `Together that's more than ${MAX_LINE_QUANTITY}. For a larger order, please ask a member of staff.`,
      })
    } else if (result.refusedBecause === 'price') {
      toast({
        title: 'Kept separate — different prices',
        description:
          'These were added at different prices, so we have kept them separate. Each keeps the price you were shown.',
      })
    } else if (result.clamped) {
      toast({
        title: `Set to ${MAX_LINE_QUANTITY}, the maximum per item`,
        description: 'For a larger order, please ask a member of staff.',
      })
    } else if (result.merged) {
      toast({ title: 'Combined with the matching item in your cart' })
    }
  }

  const handleUpdateItem = (updatedCartItem: CartItem) => {
    if (editingIndex === null) return

    commitLineEdit(editingIndex, updatedCartItem)

    setEditingIndex(null)
    setEditingItem(null)
  }

  const subtotal = getTotal()
  const total = subtotal

  const enabledPaymentMethods = useMemo(() => {
    if (restaurantLoading) {
      return { cash: true, card: true }
    }
    if (!Array.isArray(enabledMethods) || enabledMethods.length === 0) {
      return { cash: true, card: true }
    }
    const normalized = enabledMethods.map((method) => String(method))
    return {
      cash: normalized.includes('cash'),
      card: normalized.includes('card'),
    }
  }, [restaurantLoading, enabledMethods])

  const enabledKioskMethods = useMemo(() => {
    const methods = kioskPaymentMethods ?? ['cash', 'card', 'other']
    return {
      cash: methods.includes('cash'),
      card: methods.includes('card'),
      other: methods.includes('other'),
    }
  }, [kioskPaymentMethods])

  const showPaymentMethodChoice =
    enabledPaymentMethods.cash && enabledPaymentMethods.card

  const resolvedPaymentChoice = useMemo((): PaymentChoice => {
    if (inTabFlow || restaurantLoading) return paymentChoice
    if (enabledPaymentMethods.cash && !enabledPaymentMethods.card) return 'cash'
    if (enabledPaymentMethods.card && !enabledPaymentMethods.cash) return 'card_manual'
    return paymentChoice
  }, [
    inTabFlow,
    restaurantLoading,
    enabledPaymentMethods.cash,
    enabledPaymentMethods.card,
    paymentChoice,
  ])

  const handleAddToTab = async () => {
    if (paying) return
    if (!inTabFlow || !effectiveTabId) return
    if (tabReadyToPay) {
      toast({
        title: 'Tab is ready to pay',
        description: 'Your waiter has been notified. You cannot add more items.',
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
        orderInstructions: orderInstructions?.trim() || '',
      }
      const idem = getOrCreateCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      const response = await fetchWithSession('/api/orders', restaurantId, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idem ? { 'x-idempotency-key': idem } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (response.status === 410) {
        handleSessionExpired(restaurantId)
        return
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to add to tab')
      console.log('[CART] add to tab success', data)
      clearCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      await refreshTab()
      if (typeof window !== 'undefined' && data?.orderId) {
        sessionStorage.setItem('last_order_id', String(data.orderId))
        sessionStorage.setItem('flashtap_return_order_id', String(data.orderId))
        if (tableNumber > 0) sessionStorage.setItem('flashtap_return_table', String(tableNumber))
      }
      clearCart()
      /**
       * Redesign spec section 16: Place Order lands on MY ORDERS, not back on the menu.
       *
       * The menu was the wrong destination for the same reason the confirmation page is the
       * wrong destination on the other path -- the customer's question the instant after
       * ordering is "did that work, and what is happening with it", and only My Orders answers
       * it. Landing on the menu answered it with a toast, which is the weakest possible carrier:
       * #207 is the live instance of a toast being dropped outright.
       *
       * The banner is raised by the DESTINATION from `?placed=1`, not fired from here, so it
       * survives the navigation rather than racing it.
       */
      router.replace(
        `/menu/${restaurantId}/my-orders${myOrdersPlacedQuery}`
      )
    } catch (err: any) {
      toast({
        title: 'Could not add to tab',
        description: customerSafeError(err, 'Please try again.'),
        variant: 'destructive',
      })
    } finally {
      setPaying(false)
    }
  }

  const handlePlaceOrder = async () => {
    if (paying) return
    if (inTabFlow) return
    if (resolvedPaymentChoice === 'online') return
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
      const { paymentMethod, paymentChannel } = buildPaymentFields(resolvedPaymentChoice)
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
        customer_name: isKiosk ? kioskCustomerName || null : null,
        channel: isKiosk ? 'kiosk' : 'table',
      }
      const idem = getOrCreateCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
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

      clearCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('last_order_id', String(orderId))
        sessionStorage.setItem('flashtap_return_order_id', String(orderId))
        sessionStorage.setItem('flashtap_return_table', String(tableNumber))
      }
      clearCart()

      const confirmQs = new URLSearchParams()
      if (tableNumber > 0) confirmQs.set('table', String(tableNumber))
      const confirmSuffix = confirmQs.toString() ? `?${confirmQs.toString()}` : ''
      if (isKiosk) {
        const orderLabel =
          (typeof data?.kioskOrderLabel === 'string' && data.kioskOrderLabel) ||
          (data?.kioskOrderNumber != null
            ? `K-${String(data.kioskOrderNumber).padStart(3, '0')}`
            : undefined)
        router.replace(
          kioskSuccessPath(restaurantId, String(tableNumber), kioskCustomerName, orderLabel, orderId)
        )
      } else {
        router.replace(`/menu/${restaurantId}/order-confirmation/${orderId}${confirmSuffix}`)
      }
    } catch (err: unknown) {
      toast({
        title: 'Order failed',
        description: customerSafeError(err, 'Please try again.'),
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

  if (tabSessionRedirecting) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
        <p className="text-sm text-muted-foreground max-w-xs">
          Your session has ended. Scan the QR code to start a new order.
        </p>
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
            <div className="flex flex-col items-center gap-3">
              <Link href={`/menu/${restaurantId}/browse${menuQuery}`}>
                <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans px-8">
                  Browse Menu
                </Button>
              </Link>
              {/* This is the screen a customer lands on right after placing an order — the cart
                  has just been emptied by the submit. Without this they are told they have
                  nothing, with no route to the thing they just did. */}
              <Link href={`/menu/${restaurantId}/my-orders${menuQuery}`}>
                <Button variant="outline" className="font-sans px-8">
                  {CUSTOMER_NAV_COPY.myOrders}
                </Button>
              </Link>
            </div>
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
                    <CartItemNote
                      index={index}
                      itemLabel={item.display_name || item.name}
                      value={item.special_instructions || ''}
                      // Per keystroke: just the text, so the field the customer is typing in
                      // is never pulled out from under them.
                      onChange={(note) =>
                        updateItem(index, { ...item, special_instructions: note })
                      }
                      // On finishing: reconcile, because the note is part of the line's
                      // identity and this edit may have made the row a duplicate.
                      onCommit={(note) =>
                        commitLineEdit(index, { ...item, special_instructions: note })
                      }
                    />

                    {/* Price + Actions */}
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="font-sans text-base font-bold text-foreground sm:text-lg">
                        <span className="mr-0.5 text-xs font-normal text-muted-foreground sm:text-sm">
                          {currency}
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
                  <span className="text-foreground">{currency}{subtotal.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="mb-6 border-t border-border pt-4">
                <div className="flex justify-between items-center">
                  <span className="font-sans text-lg font-semibold text-foreground">Total</span>
                  <span className="font-sans text-2xl font-bold text-foreground">
                    {currency}{total.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Order Instructions */}
              <div className="mb-6">
                <Label htmlFor="instructions" className="mb-1 block font-sans text-base text-foreground">
                  Instructions for the whole order (optional)
                </Label>
                {/* The old label read just "Order Instructions", which gave a customer wanting
                    "no sugar" on one of two coffees no reason to think this was the wrong box. */}
                <p className="mb-2 font-sans text-sm text-muted-foreground">
                  For one item only, use &ldquo;Add a note&rdquo; on that item above.
                </p>
                <Textarea
                  id="instructions"
                  placeholder="Anything the kitchen should know about the whole order?"
                  value={orderInstructions}
                  onChange={(e) => setOrderInstructions(e.target.value)}
                  maxLength={MAX_INSTRUCTIONS_LENGTH}
                  rows={3}
                  className="w-full max-w-full font-sans border-border text-sm sm:text-base"
                />
              </div>

              {!inTabFlow && showPaymentMethodChoice && (
                <div className="mb-6" role="radiogroup" aria-label="Payment method">
                  <Label className="mb-3 block font-sans text-base font-semibold text-foreground">
                    How would you like to pay?
                  </Label>
                  <div className="grid gap-3">
                    {ENABLE_ONLINE_CARD_CHECKOUT && enabledPaymentMethods.card && (
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
                      <span className="ml-2 font-semibold text-foreground">Online (card)</span>
                      <p className="mt-1 text-sm text-muted-foreground">Pay now with card online</p>
                    </button>
                    )}
                    {(isKiosk ? enabledKioskMethods.cash : enabledPaymentMethods.cash) && (
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
                      <span className="ml-2 font-semibold text-foreground">
                        {isKiosk ? 'Pay at the counter' : 'Pay at table with cash'}
                      </span>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isKiosk
                          ? 'Collect your order and pay at the counter'
                          : 'Staff will collect cash at your table'}
                      </p>
                    </button>
                    )}
                    {(isKiosk ? enabledKioskMethods.card : enabledPaymentMethods.card) && (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={paymentChoice === 'card_manual'}
                      onClick={() => setPaymentChoice('card_manual')}
                      disabled={paying}
                      className={cn(
                        'rounded-lg border-2 p-4 text-left transition-colors font-sans',
                        paymentChoice === 'card_manual'
                          ? 'border-foreground bg-muted/50'
                          : 'border-border bg-background hover:border-muted-foreground/40',
                        paying && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="text-lg" aria-hidden>
                        💳
                      </span>
                      <span className="ml-2 font-semibold text-foreground">
                        {isKiosk ? 'Tap your card at the counter' : 'Pay at table with card'}
                      </span>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isKiosk
                          ? 'Tap your card at the counter when you collect your order'
                          : 'Staff will bring their card machine to your table'}
                      </p>
                    </button>
                    )}
                    {(isKiosk ? enabledKioskMethods.other : showPaymentMethodChoice) && (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={paymentChoice === 'other'}
                      onClick={() => setPaymentChoice('other')}
                      disabled={paying}
                      className={cn(
                        'rounded-lg border-2 p-4 text-left transition-colors font-sans',
                        paymentChoice === 'other'
                          ? 'border-foreground bg-muted/50'
                          : 'border-border bg-background hover:border-muted-foreground/40',
                        paying && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <span className="text-lg" aria-hidden>
                        🤝
                      </span>
                      <span className="ml-2 font-semibold text-foreground">Other</span>
                      <p className="mt-1 text-sm text-muted-foreground">Staff will assist with payment at your table</p>
                    </button>
                    )}
                  </div>
                </div>
              )}

              {inTabFlow && (
                <div>
                  <Button
                    className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
                    size="lg"
                    onClick={handleAddToTab}
                    disabled={paying || tabReadyToPay || tabStatus !== 'open'}
                  >
                    {paying ? CART_COPY.placeOrderBusy : CART_COPY.placeOrderCta}
                  </Button>
                  {/* What the button actually does, because "Add to Tab" read as bookkeeping — as
                      though the order were being noted down rather than sent to the kitchen. The
                      tab flow is the only one that said "Add"; the kiosk button below has always
                      read "Place Order", so this also makes the two agree. */}
                  <p className="mt-2 text-center text-sm text-muted-foreground font-sans">
                    {CART_COPY.placeOrderHelp}
                  </p>
                </div>
              )}

              {isKiosk && !inTabFlow && (
                <Button
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
                  size="lg"
                  onClick={handlePlaceOrder}
                  disabled={paying || items.length === 0}
                >
                  {paying ? 'Placing order…' : 'Place Order'}
                </Button>
              )}

              {!inTabFlow && !isKiosk && (
                <div className="text-center py-4">
                  <p className="text-sm text-muted-foreground font-sans mb-3">
                    You need a tab to place an order.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      router.replace(
                        `/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`
                      )
                    }
                  >
                    Create a Tab
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Edit Item Modal */}
      {editingItem && editingIndex !== null && (
        <ItemDetailModal
          item={editingItem}
          editingLine={items[editingIndex] ?? null}
          restaurant={restaurant ? { ...restaurant, currency } : { currency }}
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
