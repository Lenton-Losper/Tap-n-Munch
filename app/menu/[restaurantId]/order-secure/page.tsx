'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
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
import {
  formatCardNumberInput,
  formatExpiryMmYyInput,
  normalizeCardDigits,
  validateCardNumberDigits,
  validateCardholderName,
  validateCvv,
  validateExpiryMmYy,
} from '@/lib/card-validation'
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
  const [cardNo, setCardNo] = useState('')
  const [cardHolder, setCardHolder] = useState('')
  const [expiryMmYy, setExpiryMmYy] = useState('')
  const [cvv, setCvv] = useState('')

  const [blurred, setBlurred] = useState({
    cardNo: false,
    cardHolder: false,
    expiry: false,
    cvv: false,
  })
  const [submitAttempted, setSubmitAttempted] = useState(false)
  /** Set when PayCloud failed but order exists — retry uses resumeOrderId (no duplicate order). */
  const [awaitingPaymentOrderId, setAwaitingPaymentOrderId] = useState<string | null>(null)

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

  const cardDigits = useMemo(() => normalizeCardDigits(cardNo), [cardNo])

  const cardFieldsFilled =
    cardDigits.length > 0 &&
    cardHolder.trim().length > 0 &&
    expiryMmYy.trim().length > 0 &&
    cvv.trim().length > 0

  const cardFormValid =
    paymentMethod !== 'card' ||
    (validateCardNumberDigits(cardDigits) === null &&
      validateCardholderName(cardHolder) === null &&
      validateExpiryMmYy(expiryMmYy) === null &&
      validateCvv(cvv, cardDigits) === null)

  const showCardIncompleteHint =
    paymentMethod === 'card' && submitAttempted && !cardFieldsFilled

  const cardNoError =
    (blurred.cardNo || submitAttempted) && cardDigits.length > 0
      ? validateCardNumberDigits(cardDigits)
      : null

  const cardHolderError =
    (blurred.cardHolder || submitAttempted) && cardHolder.trim().length > 0
      ? validateCardholderName(cardHolder)
      : null

  const expiryError =
    (blurred.expiry || submitAttempted) && expiryMmYy.trim().length > 0
      ? validateExpiryMmYy(expiryMmYy)
      : null

  const cvvError =
    (blurred.cvv || submitAttempted) && cvv.trim().length > 0 ? validateCvv(cvv, cardDigits) : null

  const placeOrderEnabled =
    !!paymentMethod &&
    (paymentMethod === 'cash' || cardFormValid) &&
    !submitting &&
    (awaitingPaymentOrderId != null ||
      (Array.isArray(items) && items.length > 0))

  const submitOrder = async () => {
    setSubmitAttempted(true)

    if (!awaitingPaymentOrderId && (!Array.isArray(items) || items.length === 0)) {
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

    if (paymentMethod === 'card') {
      if (!cardFieldsFilled) {
        return
      }
      if (!cardFormValid) {
        return
      }
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

      let cleanPayload: Record<string, any>

      if (awaitingPaymentOrderId && paymentMethod === 'card') {
        const exp = expiryMmYy.trim().match(/^(\d{2})\/(\d{2})$/)
        const yy = exp ? exp[2]! : ''
        const expireYear = yy.length === 2 ? `20${yy}` : yy
        cleanPayload = {
          restaurantId: String(restaurantId),
          tableNumber: Number(tableNumber) || 0,
          session_id: String(sessionId),
          paymentMethod: 'card',
          resumeOrderId: awaitingPaymentOrderId,
          card: {
            cardNo: cardDigits,
            cardHolder: cardHolder.trim(),
            expireMonth: exp ? exp[1]! : '',
            expireYear,
            cvv: cvv.trim(),
          },
        }
      } else {
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

        if (paymentMethod === 'card') {
          const exp = expiryMmYy.trim().match(/^(\d{2})\/(\d{2})$/)
          const yy = exp ? exp[2]! : ''
          const expireYear = yy.length === 2 ? `20${yy}` : yy
          payload.card = {
            cardNo: cardDigits,
            cardHolder: cardHolder.trim(),
            expireMonth: exp ? exp[1]! : '',
            expireYear,
            cvv: cvv.trim(),
          }
        }

        cleanPayload = JSON.parse(JSON.stringify(payload))
        if (payload.session_id) cleanPayload.session_id = payload.session_id
      }

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

      if (data.paymentPending === true) {
        setAwaitingPaymentOrderId(orderId)
        setSubmitting(false)
        toast({
          title: 'Order placed',
          description: 'Your order was placed. Please complete payment below.',
        })
        return
      }

      setAwaitingPaymentOrderId(null)
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

        {awaitingPaymentOrderId && (
          <div
            className="mb-6 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm font-sans text-foreground"
            role="status"
          >
            <p className="font-semibold">Your order was placed. Please complete payment below.</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Order ID: {awaitingPaymentOrderId.slice(0, 8)}… — if payment keeps failing, tell staff this reference.
            </p>
          </div>
        )}

        <div className="mb-6 border border-border bg-card p-4 sm:p-6">
          <h2 className="text-lg font-serif font-bold text-foreground mb-4">Payment Method</h2>
          <PaymentMethodSelector
            value={paymentMethod}
            onChange={(m) => {
              setPaymentMethod(m)
              setSubmitAttempted(false)
              if (m !== 'card') setAwaitingPaymentOrderId(null)
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
          <div className="mb-6 border border-border bg-card p-4 sm:p-6 space-y-4">
            <h2 className="text-lg font-serif font-bold text-foreground">Card Details</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="card-no" className="text-foreground font-sans text-sm">
                  Card number
                </Label>
                <input
                  id="card-no"
                  inputMode="numeric"
                  autoComplete="cc-number"
                  className="mt-1 w-full border border-border bg-background p-3 text-sm font-sans rounded-md"
                  placeholder="1234 5678 9012 3456"
                  value={cardNo}
                  onChange={(e) => setCardNo(formatCardNumberInput(e.target.value))}
                  onBlur={() => setBlurred((b) => ({ ...b, cardNo: true }))}
                />
                {cardNoError && <p className="mt-1 text-sm text-destructive font-sans">{cardNoError}</p>}
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="card-holder" className="text-foreground font-sans text-sm">
                  Cardholder name
                </Label>
                <input
                  id="card-holder"
                  autoComplete="cc-name"
                  className="mt-1 w-full border border-border bg-background p-3 text-sm font-sans rounded-md"
                  placeholder="Name on card"
                  value={cardHolder}
                  onChange={(e) => setCardHolder(e.target.value)}
                  onBlur={() => setBlurred((b) => ({ ...b, cardHolder: true }))}
                />
                {cardHolderError && (
                  <p className="mt-1 text-sm text-destructive font-sans">{cardHolderError}</p>
                )}
              </div>
              <div>
                <Label htmlFor="card-expiry" className="text-foreground font-sans text-sm">
                  Expiry (MM/YY)
                </Label>
                <input
                  id="card-expiry"
                  autoComplete="cc-exp"
                  className="mt-1 w-full border border-border bg-background p-3 text-sm font-sans rounded-md"
                  placeholder="MM/YY"
                  value={expiryMmYy}
                  onChange={(e) => setExpiryMmYy(formatExpiryMmYyInput(expiryMmYy, e.target.value))}
                  onBlur={() => setBlurred((b) => ({ ...b, expiry: true }))}
                />
                {expiryError && <p className="mt-1 text-sm text-destructive font-sans">{expiryError}</p>}
              </div>
              <div>
                <Label htmlFor="card-cvv" className="text-foreground font-sans text-sm">
                  CVV
                </Label>
                <input
                  id="card-cvv"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  className="mt-1 w-full border border-border bg-background p-3 text-sm font-sans rounded-md"
                  placeholder="123 or 1234"
                  maxLength={4}
                  value={cvv}
                  onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  onBlur={() => setBlurred((b) => ({ ...b, cvv: true }))}
                />
                {cvvError && <p className="mt-1 text-sm text-destructive font-sans">{cvvError}</p>}
              </div>
            </div>
            {showCardIncompleteHint && (
              <p className="text-sm text-destructive font-sans font-medium">
                Please complete your card details to continue
              </p>
            )}
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
            ? awaitingPaymentOrderId
              ? 'Retrying payment...'
              : 'Placing Order...'
            : awaitingPaymentOrderId
              ? 'Retry payment'
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
