'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getTableByNumber } from '@/lib/firebase/tables'
import { useCart } from '@/contexts/cart-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { PaymentMethodSelector } from '@/components/payment-method-selector'

export default function CheckoutPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  
  const { items, getTotal, clearCart } = useCart()
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  
  // Form state
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | null>(null)
  const [orderInstructions, setOrderInstructions] = useState('')

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [restaurantData, tableData] = await Promise.all([
          getRestaurant(restaurantId),
          tableNumber > 0 ? getTableByNumber(restaurantId, tableNumber) : null,
        ])
        setRestaurant(restaurantData)
        setTable(tableData)
      } catch (err) {
        console.error('Failed to load data:', err)
      } finally {
        setLoading(false)
      }
    }
    
    if (restaurantId) {
      loadData()
    }
  }, [restaurantId, tableNumber])

  const handlePlaceOrder = async () => {
    if (items.length === 0) {
      toast({
        title: 'Cart is empty',
        description: 'Please add items to your cart before placing an order.',
        variant: 'destructive',
      })
      return
    }

    // VALIDATION: Customer name is required
    if (!customerName || customerName.trim() === '') {
      toast({
        title: 'Name required',
        description: 'Please enter your name to place an order.',
        variant: 'destructive',
      })
      return
    }

    // VALIDATION: Customer phone is required
    if (!customerPhone || customerPhone.trim() === '') {
      toast({
        title: 'Phone required',
        description: 'Please enter your phone number to place an order.',
        variant: 'destructive',
      })
      return
    }

    if (!table && tableNumber > 0) {
      toast({
        title: 'Invalid table',
        description: 'Please scan a valid QR code.',
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

    // Check if restaurant has enabled this payment method
    const enabledMethods = restaurant?.payment_methods || ['cash']
    if (!enabledMethods.includes(paymentMethod)) {
      toast({
        title: 'Payment method not available',
        description: 'This payment method is not enabled for this restaurant.',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)

    // Show processing alert
    toast({
      title: 'Processing your order...',
      description: 'Please wait while we process your order.',
    })

    try {
      const subtotal = getTotal()
      const taxRate = restaurant?.tax_rate || 0.15
      const tax = subtotal * taxRate
      const total = subtotal + tax

      // Prepare order items for API
      const orderItems = items.map(item => ({
        menuItemId: item.menu_item_id,
        name: item.name,
        quantity: item.quantity,
        basePrice: item.base_price,
        size: item.selected_size?.name || null,
        addons: item.selected_addons || [],
        specialInstructions: item.special_instructions || '',
        subtotal: item.subtotal,
      }))

      // Build request body with new customer object schema
      const requestBody = {
        restaurantId: String(restaurantId),
        tableNumber: Number(tableNumber) || 0,
        customer: {
          name: String(customerName).trim(),
          phone: String(customerPhone).trim(),
        },
        items: orderItems,
        subtotal: Number(subtotal),
        tax: Number(tax),
        total: Number(total),
        paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
        ...(orderInstructions && orderInstructions.trim() ? { notes: orderInstructions.trim() } : {}),
      }

      // Call API to create order
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })

      console.log('🚀 CHECKOUT - Response status:', response.status)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('🚀 CHECKOUT - API Error:', errorData)
        throw new Error(errorData.error || `Failed to place order (${response.status})`)
      }

      const data = await response.json()
      console.log('🚀 CHECKOUT - API Success:', data)
      const orderId = data.orderId

      if (!orderId) {
        throw new Error('Order was created but no order ID was returned')
      }

      // Clear cart
      clearCart()

      // Redirect to confirmation
      router.push(`/order-confirmation?orderId=${encodeURIComponent(orderId)}${tableNumber > 0 ? `&table=${tableNumber}` : ''}`)
    } catch (error: any) {
      console.error('❌ CHECKOUT - Failed to place order:', error)
      console.error('❌ CHECKOUT - Error stack:', error.stack)
      toast({
        title: 'Order failed',
        description: error.message || 'Failed to place order. Please try again.',
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  const subtotal = getTotal()
  const taxRate = restaurant?.tax_rate || 0.15
  const tax = subtotal * taxRate
  const total = subtotal + tax

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-2xl font-bold">Checkout</h1>
        </div>

        <div className="space-y-6">
          {/* Order Summary */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold mb-4">Order Summary</h2>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>{items.length} items</span>
                <span className="font-semibold">{restaurant?.currency || 'N$'}{total.toFixed(2)}</span>
              </div>
              <div className="text-sm text-gray-600">
                Subtotal: {restaurant?.currency || 'N$'}{subtotal.toFixed(2)}<br />
                Tax: {restaurant?.currency || 'N$'}{tax.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Customer Details - REQUIRED */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
            <h2 className="text-lg font-semibold">Your Details <span className="text-red-500">*</span></h2>
            <div>
              <Label htmlFor="name">Name <span className="text-red-500">*</span></Label>
              <Input
                id="name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Your name"
                required
                className={!customerName ? 'border-red-500' : ''}
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone <span className="text-red-500">*</span></Label>
              <Input
                id="phone"
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="+264..."
                required
                className={!customerPhone ? 'border-red-500' : ''}
              />
            </div>
          </div>

          {/* Table Number */}
          {tableNumber > 0 && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold mb-2">Table Number</h2>
              <p className="text-gray-600">Table {tableNumber} ✓</p>
            </div>
          )}

          {/* Payment Method */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold mb-4">Payment Method</h2>
            <PaymentMethodSelector
              selectedMethod={paymentMethod}
              onSelect={(method) => setPaymentMethod(method)}
              enabledMethods={(restaurant?.payment_methods || ['cash']) as ('cash' | 'card')[]}
              disabled={submitting}
            />
            {paymentMethod && (
              <p className="mt-4 text-sm text-gray-600">
                A staff member will come to your table to collect payment when your order is ready.
              </p>
            )}
          </div>

          {/* Order Instructions */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <Label htmlFor="order-instructions" className="text-lg font-semibold mb-2 block">
              Order Instructions
            </Label>
            <Textarea
              id="order-instructions"
              value={orderInstructions}
              onChange={(e) => setOrderInstructions(e.target.value)}
              placeholder="Any special requests for your order?"
              rows={3}
            />
          </div>

          {/* Place Order Button */}
          <Button
            onClick={handlePlaceOrder}
            disabled={submitting || items.length === 0 || !customerName.trim() || !customerPhone.trim()}
            className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white disabled:opacity-50 disabled:cursor-not-allowed"
            size="lg"
          >
            {submitting ? 'Placing Order...' : 'Place Order 🎉'}
          </Button>
          {(!customerName.trim() || !customerPhone.trim()) && (
            <p className="text-sm text-red-500 text-center">
              Please fill in your name and phone number to place an order
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

