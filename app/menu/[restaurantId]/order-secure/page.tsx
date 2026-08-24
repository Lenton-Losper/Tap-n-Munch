'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { lineConfigurationSummary } from '@/lib/orders/line-configuration'
import { clearCartIdempotencyKey, getOrCreateCartIdempotencyKey } from '@/lib/idempotency'
import { customerSafeError } from '@/lib/customer-copy/customer-safe-error'
import { rememberPlacedOrder } from '@/lib/orders/last-placed-order'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

export default function OrderSecurePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items, getTotal, clearCart } = useCart()
  const { currency } = useRestaurant()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (tableNumber > 0 && restaurantId) {
      getOrCreateSession(restaurantId, String(tableNumber))
    }
  }, [restaurantId, tableNumber])

  const placeOrderEnabled = !submitting && Array.isArray(items) && items.length > 0

  const submitOrder = async () => {
    if (submitting) return
    if (!Array.isArray(items) || items.length === 0) {
      toast({
        title: MENU_COPY.cartEmpty,
        description: MENU_COPY.pleaseAddItemsYourCart,
        variant: 'destructive',
      })
      return
    }

    let sessionId = getCurrentSession()
    if (!sessionId) {
      sessionId = getOrCreateSession(restaurantId, String(tableNumber))
    }

    if (!sessionId) {
      toast({
        title: MENU_COPY.sessionError,
        description: MENU_COPY.unableCreateSessionPleaseTry,
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    toast({ title: MENU_COPY.processingYourOrder, description: MENU_COPY.pleaseWait })

    try {
      const subtotal = getTotal()
      const total = subtotal

      const orderItems = items
        .filter((item) => item != null)
        .map((item) => ({
          menuItemId: String(item?.menu_item_id || ''),
          name: String(item?.display_name || item?.name || ''),
          displayName: String(item?.display_name || item?.name || ''),
          quantity: Number(item?.quantity) || 1,
          basePrice: Number(item?.base_price) || 0,
          selectedVariants: item?.selected_variants || {},
          size: item?.selected_size?.name ? String(item.selected_size.name) : null,
          addons: Array.isArray(item?.selected_addons)
            ? item.selected_addons
                .filter((a) => a != null)
                .map((a) => ({
                  name: String(a?.name || ''),
                  price: Number(a?.price) || 0,
                }))
            : [],
          specialInstructions: item?.special_instructions?.trim() || '',
          subtotal: Number(item?.subtotal) || 0,
        }))
        .filter((item) => item.menuItemId && item.name)

      const payload: Record<string, any> = {
        restaurantId: String(restaurantId),
        tableNumber: Number(tableNumber) || 0,
        session_id: String(sessionId),
        member_session_id: String(sessionId),
        items: orderItems,
        subtotal: Number(subtotal),
        total: Number(total),
        paymentMethod: 'card',
        paymentChannel: 'hosted',
      }

      const cleanPayload = JSON.parse(JSON.stringify(payload))
      if (payload.session_id) cleanPayload.session_id = payload.session_id

      const idem = getOrCreateCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idem ? { 'x-idempotency-key': idem } : {}),
        },
        body: JSON.stringify(cleanPayload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.error || `Failed to place order (${response.status})`)
      }

      const orderId = data.orderId as string | undefined
      if (!orderId) throw new Error(MENU_COPY.orderWasCreatedButNo)

      clearCartIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)

      const checkoutUrl = data.checkoutUrl as string | undefined
      if (!checkoutUrl) throw new Error(MENU_COPY.paymentLinkWasNotReturned)
      if (typeof window !== 'undefined') {
        rememberPlacedOrder(orderId, tableNumber)
        if (tableNumber > 0) {
          sessionStorage.setItem('flashtap_return_table', String(tableNumber))
        }
      }
      clearCart()
      window.location.href = checkoutUrl
      return
    } catch (error: any) {
      console.error('Order failure:', error)
      toast({
        title: MENU_COPY.orderFailed,
        description: customerSafeError(error, MENU_COPY.failedPlaceOrderPleaseTry),
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  const subtotal = typeof getTotal === 'function' ? getTotal() : 0
  const total = subtotal

  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-6 flex items-center gap-3 sm:mb-8">
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              router.push(`/menu/${restaurantId}/cart${tableNumber > 0 ? `?table=${tableNumber}` : ''}`)
            }
            className="h-11 w-11"
          >
            <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
          </Button>
          <div>
            <h1 className="text-xl font-serif font-bold text-foreground sm:text-2xl">{MENU_COPY.secureCheckout}</h1>
            {tableNumber > 0 && <p className="text-sm text-muted-foreground font-sans">Table {tableNumber}</p>}
          </div>
        </div>

        <div className="mb-6 border border-border bg-card p-4 sm:p-6">
          <h2 className="text-lg font-serif font-bold text-foreground mb-4">{MENU_COPY.orderSummary}</h2>
          <div className="space-y-2 mb-5">
            {items.map((item, idx) => (
              <div key={`${item.menu_item_id || item.name}-${idx}`} className="flex justify-between text-sm font-sans">
                <span className="text-foreground">
                  <span className="text-muted-foreground mr-2">{item.quantity}x</span>
                  {item.display_name || item.name}
                  {lineConfigurationSummary(item) ? (
                    <span className="block text-xs text-muted-foreground">
                      {lineConfigurationSummary(item)}
                    </span>
                  ) : null}
                </span>
                <span className="text-foreground">
                  {currency}
                  {(Number(item.subtotal) || 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="flex justify-between text-sm font-sans">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-foreground">{currency}{subtotal.toFixed(2)}</span>
            </div>
            <div className="border-t border-border pt-4 mt-4">
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold font-sans text-foreground">Total</span>
                <span className="text-xl font-bold font-sans text-foreground sm:text-2xl">
                  {currency}{total.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <Button
          onClick={submitOrder}
          disabled={!placeOrderEnabled || submitting}
          className="h-11 w-full py-6 text-base font-semibold font-sans bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-muted"
          size="lg"
        >
          {submitting ? 'Processing...' : MENU_COPY.continuePayment}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground font-sans text-center flex items-center justify-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
          {MENU_COPY.securedByFinatic}
        </p>
      </div>
    </div>
  )
}
