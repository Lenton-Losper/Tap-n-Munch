'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getTableByNumber } from '@/lib/firebase/tables'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
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
  
  // Form state - NO customer fields required
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | null>(null)
  const [orderInstructions, setOrderInstructions] = useState('')

  useEffect(() => {
    const loadData = async () => {
      try {
        const [restaurantData, tableData] = await Promise.all([
          getRestaurant(restaurantId),
          tableNumber > 0 ? getTableByNumber(restaurantId, tableNumber) : Promise.resolve(null),
        ])
        setRestaurant(restaurantData)
        setTable(tableData)
        
        // Initialize session if table number is provided
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
  }, [restaurantId, tableNumber])

  const submitOrder = async () => {
    // Defensive guard: ensure items is an array and not empty
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
    
    // PART 1: Get or create unique session_id (unique per scan)
    // CRITICAL: Fetch session_id from localStorage to attach to order
    // This ensures the Active Order Banner can find orders by session_id
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
      setSubmitting(false)
      return
    }
    
    console.log('📦 Submitting order with session_id:', sessionId)
    console.log('📦 Order creation - Session ID type:', typeof sessionId)
    
    setSubmitting(true)
    toast({ title: 'Processing your order...', description: 'Please wait while we process your order.' })

    try {

      const subtotal = getTotal()
      const taxRate = restaurant?.tax_rate || 0.15
      const tax = subtotal * taxRate
      const total = subtotal + tax

      // Prepare order items with defensive guards
      const orderItems = items
        .filter(item => item != null) // Filter out null/undefined items
        .map(item => ({
          menuItemId: String(item?.menu_item_id || ''),
          name: String(item?.name || ''),
          quantity: Number(item?.quantity) || 1,
          basePrice: Number(item?.base_price) || 0,
          size: (item?.selected_size && typeof item.selected_size === 'object' && item.selected_size.name) 
            ? String(item.selected_size.name) 
            : null,
          addons: Array.isArray(item?.selected_addons) 
            ? item.selected_addons.filter(a => a != null).map(a => ({
                name: String(a?.name || ''),
                price: Number(a?.price) || 0,
              }))
            : [],
          specialInstructions: (item?.special_instructions && typeof item.special_instructions === 'string')
            ? String(item.special_instructions).trim()
            : '',
          subtotal: Number(item?.subtotal) || 0,
        }))
        .filter(item => item.menuItemId && item.name) // Filter out invalid items

      // STEP 2: Fix Frontend Checkout Payload
      // Ensure session_id is always sent with correct field names
      const payload: Record<string, any> = {
        restaurantId: String(restaurantId), // Will be mapped to restaurant_id in API
        tableNumber: Number(tableNumber) || 0, // Will be mapped to table_id in API
        session_id: String(sessionId), // REQUIRED: Must match Firestore field name
        items: orderItems, // Will be mapped to snake_case in API
        subtotal: Number(subtotal),
        tax: Number(tax),
        total: Number(total),
        paymentMethod: paymentMethod === 'card' ? 'card' : 'cash', // Will be mapped to payment_method
        orderInstructions: orderInstructions && orderInstructions.trim() ? orderInstructions.trim() : null, // Will be mapped to order_instructions
      }
      
      // CRITICAL: JSON Car Wash - physically strip undefined properties
      const cleanPayload = JSON.parse(JSON.stringify(payload))
      
      // CRITICAL: Ensure session_id survives JSON Car Wash
      if (payload.session_id !== undefined) {
        cleanPayload.session_id = payload.session_id
      }
      
      // Log final payload to verify session_id is included
      console.log('📦 Final payload before API call:', {
        hasSessionId: 'session_id' in cleanPayload,
        sessionIdValue: cleanPayload.session_id,
        restaurantId: cleanPayload.restaurantId,
        payloadKeys: Object.keys(cleanPayload),
      })
      
      // Also check nested objects (items array) - explicit whitelist, no spread
      if (Array.isArray(cleanPayload.items)) {
        cleanPayload.items = cleanPayload.items.map((item: any) => {
          // Explicit whitelist - only include known safe fields
          const cleanItem: Record<string, any> = {
            menuItemId: item?.menuItemId || item?.menu_item_id || '',
            name: item?.name || '',
            quantity: item?.quantity || 1,
            basePrice: item?.basePrice || item?.base_price || 0,
            subtotal: item?.subtotal || 0,
            size: item?.size || null,
            addons: Array.isArray(item?.addons) ? item.addons : [],
            specialInstructions: item?.specialInstructions || item?.special_instructions || '',
          }
          // Explicitly ensure no email fields exist
          if ('customer_email' in cleanItem) delete cleanItem.customer_email
          if ('customerEmail' in cleanItem) delete cleanItem.customerEmail
          if ('email' in cleanItem) delete cleanItem.email
          return cleanItem
        })
      }
      
      // Log final payload once for verification
      console.log('ORDER PAYLOAD FINAL', JSON.stringify(cleanPayload, null, 2))
      
      // Verify no forbidden fields exist
      const payloadStr = JSON.stringify(cleanPayload)
      if (payloadStr.includes('customer_email') || payloadStr.includes('customerEmail')) {
        console.error('🚨 CRITICAL: Forbidden field detected in final payload!')
        throw new Error('Forbidden field detected: customer_email or customerEmail')
      }
      
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

  // Defensive guards for calculations
  const subtotal = typeof getTotal === 'function' ? getTotal() : 0
  const taxRate = (restaurant && typeof restaurant.tax_rate === 'number' && restaurant.tax_rate >= 0)
    ? restaurant.tax_rate
    : 0.15
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

        {/* Payment Method */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Payment Method</h2>
          <PaymentMethodSelector
            value={paymentMethod}
            onChange={setPaymentMethod}
            enabledMethods={['cash', 'card']}
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
          disabled={
            submitting || 
            !Array.isArray(items) || 
            items.length === 0 || 
            !paymentMethod
          }
          className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white"
          size="lg"
        >
          {submitting ? 'Placing Order...' : 'Place Order 🎉'}
        </Button>
        
        {!paymentMethod && (
          <p className="text-sm text-red-500 text-center mt-2">
            Please select a payment method to place the order.
          </p>
        )}
      </div>
    </div>
  )
}

