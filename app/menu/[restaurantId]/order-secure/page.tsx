'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { PaymentMethodSelector } from '@/components/payment-method-selector'
import { cn } from '@/lib/utils'

export default function OrderSecurePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')

  const { items, getTotal, clearCart } = useCart()
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | null>(null)
  const [orderInstructions, setOrderInstructions] = useState('')

  useEffect(() => {
    const loadData = async () => {
      try {
        const restaurantData = await getRestaurant(restaurantId)
        setRestaurant(restaurantData)
        if (tableNumber > 0) {
          getOrCreateSession(String(tableNumber), restaurantId)
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

  const placeOrderEnabled = !!paymentMethod && !submitting && Array.isArray(items) && items.length > 0

  const submitOrder = async () => {
    if (!Array.isArray(items) || items.length === 0) {
      toast({
        title: 'Cart is empty',
        description: 'Please add items to your cart before placing an order.',
        variant: 'destructive',
      })
      return
    }

    if (!paymentMethod) {
      toast({
        title: 'Payment method required',
        description: 'Please select a payment method.',
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
      const taxRate = restaurant?.tax_rate || 0.15
      const tax = subtotal * taxRate
      const total = subtotal + tax

      const orderItems = items
        .filter((item) => item != null)
        .map((item) => ({
          menuItemId: String(item?.menu_item_id || ''),
          name: String(item?.name || ''),
          quantity: Number(item?.quantity) || 1,
          basePrice: Number(item?.base_price) || 0,
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
        items: orderItems,
        subtotal: Number(subtotal),
        tax: Number(tax),
        total: Number(total),
        paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
        orderInstructions: orderInstructions?.trim() || null,
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

      if (paymentMethod === 'card') {
        const checkoutUrl = data.checkoutUrl as string | undefined
        if (!checkoutUrl) throw new Error('Payment link was not returned by PayCloud')
        clearCart()
        window.location.href = checkoutUrl
        return
      }

      clearCart()
      router.push(
        `/order-confirmation?orderId=${encodeURIComponent(orderId)}${tableNumber > 0 ? `&table=${tableNumber}` : ''}`
      )
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
  const taxRate = restaurant?.tax_rate || 0.15
  const tax = subtotal * taxRate
  const total = subtotal + tax

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
          <h2 className="text-lg font-serif font-bold text-foreground mb-4">Payment Method</h2>
          <PaymentMethodSelector
            value={paymentMethod}
            onChange={(m) => {
              setPaymentMethod(m)
            }}
            enabledMethods={['cash', 'card']}
          />
        </div>

        <div className="mb-6 border border-border bg-card p-4 sm:p-6">
          <Label htmlFor="instructions" className="mb-3 block font-sans text-foreground font-semibold">
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

        {paymentMethod === 'card' && (
          <div className="mb-6 border border-border bg-card p-4 sm:p-6">
            <p className="text-sm text-muted-foreground font-sans">
              You will be redirected to PayCloud Hosted Checkout to enter your card details securely.
            </p>
          </div>
        )}

        <div className="mb-6 border border-border bg-card p-4 sm:p-6">
          <h2 className="text-lg font-serif font-bold text-foreground mb-4">Order Summary</h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm font-sans">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-foreground">{restaurant?.currency || 'N$'}{subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm font-sans">
              <span className="text-muted-foreground">Tax ({Math.round(taxRate * 100)}%)</span>
              <span className="text-foreground">{restaurant?.currency || 'N$'}{tax.toFixed(2)}</span>
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
          className={cn(
            'h-11 w-full py-6 text-base font-semibold font-sans',
            placeOrderEnabled
              ? 'bg-foreground text-background hover:bg-foreground/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed opacity-70 hover:bg-muted'
          )}
          size="lg"
        >
          {submitting
            ? paymentMethod === 'card'
              ? 'Redirecting to payment...'
              : 'Placing Order...'
            : paymentMethod === 'card'
              ? 'Place Order & Proceed to Payment'
              : 'Place Order'}
        </Button>

        {!paymentMethod && (
          <p className="text-sm text-destructive text-center mt-3 font-sans">
            Please select a payment method to place the order.
          </p>
        )}
      </div>
    </div>
  )
}
