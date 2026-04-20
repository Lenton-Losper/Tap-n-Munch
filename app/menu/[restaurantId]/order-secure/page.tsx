'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'

export default function OrderSecurePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items, getTotal, clearCart } = useCart()
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const restaurantData = await getRestaurant(restaurantId)
        setRestaurant(restaurantData)
        if (tableNumber > 0) {
          getOrCreateSession(restaurantId, String(tableNumber))
        }
      } catch (err) {
        console.error('Failed to load data:', err)
        toast({
          title: 'Error',
          description: 'Failed to load restaurant information.',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    if (restaurantId) {
      loadData()
    }
  }, [restaurantId, tableNumber, toast])

  const placeOrderEnabled = !submitting && Array.isArray(items) && items.length > 0

  const submitOrder = async () => {
    if (!Array.isArray(items) || items.length === 0) {
      toast({
        title: 'Cart is empty',
        description: 'Please add items to your cart before placing an order.',
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
        title: 'Session Error',
        description: 'Unable to create session. Please try again.',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    toast({ title: 'Processing your order...', description: 'Please wait.' })

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

      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanPayload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.error || `Failed to place order (${response.status})`)
      }

      const orderId = data.orderId as string | undefined
      if (!orderId) throw new Error('Order was created but no order ID was returned')

      const checkoutUrl = data.checkoutUrl as string | undefined
      if (!checkoutUrl) throw new Error('Payment link was not returned by PayCloud')
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('last_order_id', orderId)
        sessionStorage.setItem('flashtap_return_order_id', orderId)
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
        title: 'Order failed',
        description: error.message || 'Failed to place order. Please try again.',
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  const subtotal = typeof getTotal === 'function' ? getTotal() : 0
  const total = subtotal

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

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
            <h1 className="text-xl font-serif font-bold text-foreground sm:text-2xl">Secure Checkout</h1>
            {tableNumber > 0 && <p className="text-sm text-muted-foreground font-sans">Table {tableNumber}</p>}
          </div>
        </div>

        <div className="mb-6 border border-border bg-card p-4 sm:p-6">
          <h2 className="text-lg font-serif font-bold text-foreground mb-4">Order Summary</h2>
          <div className="space-y-2 mb-5">
            {items.map((item, idx) => (
              <div key={`${item.menu_item_id || item.name}-${idx}`} className="flex justify-between text-sm font-sans">
                <span className="text-foreground">
                  <span className="text-muted-foreground mr-2">{item.quantity}x</span>
                  {item.display_name || item.name}
                </span>
                <span className="text-foreground">
                  {restaurant?.currency || 'N$'}
                  {(Number(item.subtotal) || 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="flex justify-between text-sm font-sans">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-foreground">{restaurant?.currency || 'N$'}{subtotal.toFixed(2)}</span>
            </div>
            <div className="border-t border-border pt-4 mt-4">
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold font-sans text-foreground">Total</span>
                <span className="text-xl font-bold font-sans text-foreground sm:text-2xl">
                  {restaurant?.currency || 'N$'}{total.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <Button
          onClick={submitOrder}
          disabled={!placeOrderEnabled}
          className="h-11 w-full py-6 text-base font-semibold font-sans bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-muted"
          size="lg"
        >
          {submitting ? 'Redirecting to payment...' : 'Continue to Payment'}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground font-sans text-center flex items-center justify-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
          Secured by Finatic
        </p>
      </div>
    </div>
  )
}
