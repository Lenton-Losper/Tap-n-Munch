'use client'

export const dynamic = "force-dynamic"

console.log('🛡️ SECURITY: Running SDK-Free Flow')

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

export default function OrderSecurePage() {
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
  
  // Form state - both required
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | null>(null)
  const [orderInstructions, setOrderInstructions] = useState('')
  
  // Validation state
  const [nameError, setNameError] = useState(false)
  const [phoneError, setPhoneError] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [restaurantData, tableData] = await Promise.all([
          getRestaurant(restaurantId),
          tableNumber > 0 ? getTableByNumber(restaurantId, tableNumber) : Promise.resolve(null),
        ])
        setRestaurant(restaurantData)
        setTable(tableData)
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
  }, [restaurantId, tableNumber])

  const submitOrder = async () => {
    // Reset validation errors
    setNameError(false)
    setPhoneError(false)
    
    // VALIDATION: Customer name is required
    if (!customerName || customerName.trim() === '') {
      setNameError(true)
      toast({
        title: 'Customer name required',
        description: 'Please enter your name.',
        variant: 'destructive',
      })
      return
    }
    
    // VALIDATION: Customer phone is required
    if (!customerPhone || customerPhone.trim() === '') {
      setPhoneError(true)
      toast({
        title: 'Customer phone required',
        description: 'Please enter your phone number.',
        variant: 'destructive',
      })
      return
    }
    
    if (items.length === 0) {
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
    
    setSubmitting(true)
    toast({ title: 'Processing your order...', description: 'Please wait while we process your order.' })

    try {
      const subtotal = getTotal()
      const taxRate = restaurant?.tax_rate || 0.15
      const tax = subtotal * taxRate
      const total = subtotal + tax

      // Prepare order items
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

      // Construct payload object
      const payload = {
        restaurantId: String(restaurantId),
        tableNumber: Number(tableNumber) || 0,
        customerName: String(customerName).trim(),
        customerPhone: String(customerPhone).trim(),
        items: orderItems,
        subtotal: Number(subtotal),
        tax: Number(tax),
        total: Number(total),
        paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
        orderInstructions: orderInstructions && orderInstructions.trim() ? orderInstructions.trim() : null,
      }

      // CRITICAL: JSON Car Wash - physically strip undefined properties
      const cleanPayload = JSON.parse(JSON.stringify(payload))
      
      console.log('🛡️ SECURITY: Sending order to API (SDK-Free)')
      console.log('🛡️ SECURITY: Payload keys:', Object.keys(cleanPayload))
      console.log('🛡️ SECURITY: Has customer_email?', 'customer_email' in cleanPayload)
      
      // Send to API using fetch (NO Firebase SDK)
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cleanPayload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to place order (${response.status})`)
      }

      const data = await response.json()
      const orderId = data.orderId

      if (!orderId) {
        throw new Error('Order was created but no order ID was returned')
      }

      // Clear cart
      clearCart()

      // Redirect to confirmation
      router.push(`/order-confirmation?orderId=${encodeURIComponent(orderId)}${tableNumber > 0 ? `&table=${tableNumber}` : ''}`)
    } catch (error: any) {
      console.error('❌ ORDER FAILURE:', error)
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
          <div>
            <h1 className="text-2xl font-bold">Secure Checkout</h1>
            {tableNumber > 0 && (
              <p className="text-sm text-gray-500">Table {tableNumber}</p>
            )}
          </div>
        </div>

        {/* Customer Information */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Customer Information</h2>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="name" className="mb-2 block">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value)
                  setNameError(false)
                }}
                placeholder="Your name"
                required
                className={nameError ? 'border-red-500' : ''}
                autoComplete="name"
              />
              {nameError && (
                <p className="text-sm text-red-500 mt-1">Name is required</p>
              )}
            </div>

            <div>
              <Label htmlFor="phone" className="mb-2 block">
                Phone Number <span className="text-red-500">*</span>
              </Label>
              <Input
                id="phone"
                type="tel"
                value={customerPhone}
                onChange={(e) => {
                  setCustomerPhone(e.target.value)
                  setPhoneError(false)
                }}
                placeholder="+264..."
                required
                className={phoneError ? 'border-red-500' : ''}
                autoComplete="tel"
              />
              {phoneError && (
                <p className="text-sm text-red-500 mt-1">Phone number is required</p>
              )}
            </div>
          </div>
        </div>

        {/* Payment Method */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Payment Method</h2>
          <PaymentMethodSelector
            value={paymentMethod}
            onChange={setPaymentMethod}
          />
        </div>

        {/* Order Instructions */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <Label htmlFor="instructions" className="mb-2 block">
            Order Instructions (Optional)
          </Label>
          <Textarea
            id="instructions"
            placeholder="Any special requests for your order?"
            value={orderInstructions}
            onChange={(e) => setOrderInstructions(e.target.value)}
            rows={3}
          />
        </div>

        {/* Order Summary */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Order Summary</h2>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Subtotal</span>
              <span>{restaurant?.currency || 'N$'}{subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Tax ({Math.round(taxRate * 100)}%)</span>
              <span>{restaurant?.currency || 'N$'}{tax.toFixed(2)}</span>
            </div>
            <div className="border-t pt-2 mt-2">
              <div className="flex justify-between text-lg font-bold">
                <span>Total</span>
                <span className="text-[#FF6B35]">
                  {restaurant?.currency || 'N$'}{total.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Place Order Button */}
        <Button
          onClick={submitOrder}
          disabled={submitting || items.length === 0 || !customerName.trim() || !customerPhone.trim() || !paymentMethod}
          className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white"
          size="lg"
        >
          {submitting ? 'Placing Order...' : 'Place Order 🎉'}
        </Button>
        
        {(!customerName.trim() || !customerPhone.trim() || !paymentMethod) && (
          <p className="text-sm text-red-500 text-center mt-2">
            Please fill in all required fields to place the order.
          </p>
        )}
      </div>
    </div>
  )
}

