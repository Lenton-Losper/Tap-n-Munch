import { NextRequest, NextResponse } from 'next/server'
import { createOrder } from '@/lib/firebase/orders'
import { sanitizeFirestoreData } from '@/lib/firebase/firestore-utils'

// Basic shape expected from the client
type IncomingOrderItem = {
  menuItemId: string | number
  name: string
  quantity: number
  basePrice: number
  size?: string | null
  addons?: { name: string; price: number }[]
  specialInstructions?: string
  subtotal: number
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Explicitly destructure with null defaults to prevent undefined
    const {
      restaurantId,
      tableNumber = null,
      items,
      subtotal: providedSubtotal,
      tax: providedTax,
      total: providedTotal,
      paymentMethod = 'cash',
      notes = null,
      customerName = null,
      customerPhone = null,
    }: {
      restaurantId?: string
      tableNumber?: number | null
      items?: IncomingOrderItem[]
      subtotal?: number
      tax?: number
      total?: number
      paymentMethod?: 'cash' | 'card' | 'mobile_money'
      notes?: string | null
      customerName?: string | null
      customerPhone?: string | null
    } = body || {}

    if (!restaurantId || !items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'Missing or invalid restaurantId or items' },
        { status: 400 }
      )
    }

    const safeTableNumber = typeof tableNumber === 'number' && tableNumber > 0 ? tableNumber : 0
    const method: 'cash' | 'card' | 'mobile_money' = paymentMethod || 'cash'

    // Calculate subtotal from items if not provided, otherwise use provided subtotal
    const calculatedSubtotal = items.reduce((sum, item) => sum + (item.subtotal || 0), 0)
    const subtotal = typeof providedSubtotal === 'number' && providedSubtotal > 0 
      ? providedSubtotal 
      : calculatedSubtotal
    
    // Use provided tax if available, otherwise calculate from subtotal
    const tax = typeof providedTax === 'number' ? providedTax : 0
    const service_fee = 0
    const discount = 0
    const tip = 0
    
    // Use provided total if available, otherwise calculate
    const total = typeof providedTotal === 'number' && providedTotal > 0
      ? providedTotal
      : subtotal + tax + service_fee - discount + tip

    const orderItems = items.map((item) => ({
      menu_item_id: String(item.menuItemId),
      name: item.name,
      quantity: item.quantity,
      base_price: item.basePrice,
      selected_size: item.size
        ? { name: item.size, price_modifier: 0 }
        : null,
      selected_addons: item.addons || [],
      special_instructions: item.specialInstructions || '',
      subtotal: item.subtotal,
    }))

    // Helper to safely convert to string or null (never undefined)
    const safeString = (value: any): string | null => {
      if (value === undefined || value === null) return null
      const str = String(value).trim()
      return str !== '' ? str : null
    }
    
    // Build order data from scratch - ONLY include fields we explicitly want
    // This ensures NO undefined values can slip through
    const orderData: Record<string, any> = {
      // Required fields (always present with safe defaults)
      restaurant_id: String(restaurantId),
      table_id: '',
      table_number: Number(safeTableNumber) || 0,
      items: Array.isArray(orderItems) ? orderItems : [],
      subtotal: Number(subtotal) || 0,
      tax: Number(tax) || 0,
      service_fee: Number(service_fee) || 0,
      discount: Number(discount) || 0,
      tip: Number(tip) || 0,
      total: Number(total) || 0,
      payment_method: String(method),
      payment_status: 'pending',
      status: 'new',
    }
    
    // Optional fields: only add if they have valid values (omit if null)
    const safeCustomerName = safeString(customerName)
    if (safeCustomerName !== null) {
      orderData.customer_name = safeCustomerName
    }
    
    const safeCustomerPhone = safeString(customerPhone)
    if (safeCustomerPhone !== null) {
      orderData.customer_phone = safeCustomerPhone
    }
    
    const safeNotes = safeString(notes)
    if (safeNotes !== null) {
      orderData.order_instructions = safeNotes
    }
    
    // Defensive logging (temporary - remove after verification)
    console.log('API ORDER DATA BEFORE SANITIZATION →', orderData)
    console.log('Has undefined values?', Object.values(orderData).some(v => v === undefined))
    
    // CRITICAL: Sanitize before passing to createOrder - removes any undefined values
    const sanitizedOrderData = sanitizeFirestoreData(orderData)
    
    // Final validation
    const hasUndefined = Object.values(sanitizedOrderData).some(v => v === undefined)
    if (hasUndefined) {
      console.error('ERROR: Undefined values still present after sanitization:', sanitizedOrderData)
      console.error('Problematic fields:', Object.entries(sanitizedOrderData).filter(([_, v]) => v === undefined))
      throw new Error('Order data contains undefined values after sanitization')
    }
    
    console.log('API ORDER DATA AFTER SANITIZATION →', sanitizedOrderData)
    console.log('Final check - Has undefined values?', Object.values(sanitizedOrderData).some(v => v === undefined))
    
    const orderId = await createOrder(sanitizedOrderData)

    return NextResponse.json({ orderId }, { status: 201 })
  } catch (error: any) {
    console.error('Error creating order via API:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to create order' },
      { status: 500 }
    )
  }
}



