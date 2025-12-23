import { db } from '@/lib/firebase/config'
import { collection, addDoc } from 'firebase/firestore'
import { NextResponse } from 'next/server'
import { getNextOrderNumber } from '@/lib/firebase/orders'
import { prepareForFirestore } from '@/lib/firebase/firestore-guards'

/**
 * ORDER CREATION API - EXPLICIT CONSTRUCTION
 * 
 * STEP 4: Explicit Order Object (NO PASS-THROUGH)
 * 
 * This route:
 * 1. Validates required fields
 * 2. Explicitly constructs order object (no spread operators)
 * 3. Uses prepareForFirestore() to guard and sanitize
 * 4. Writes to Firestore
 * 
 * API Contract:
 * POST /api/orders
 * {
 *   restaurantId: string,
 *   tableNumber: number,
 *   customer: {
 *     name: string,
 *     phone: string
 *   },
 *   items: OrderItem[],
 *   total: number
 * }
 */
export async function POST(req: Request) {
  try {
    const rawData = await req.json()
    
    // VALIDATION: Required fields
    if (!rawData.restaurantId || typeof rawData.restaurantId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid restaurantId' },
        { status: 400 }
      )
    }

    if (!rawData.customer || typeof rawData.customer !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid customer object' },
        { status: 400 }
      )
    }

    if (!rawData.customer.name || typeof rawData.customer.name !== 'string' || rawData.customer.name.trim() === '') {
      return NextResponse.json(
        { error: 'Missing or invalid customer.name' },
        { status: 400 }
      )
    }

    if (!rawData.customer.phone || typeof rawData.customer.phone !== 'string' || rawData.customer.phone.trim() === '') {
      return NextResponse.json(
        { error: 'Missing or invalid customer.phone' },
        { status: 400 }
      )
    }

    if (!rawData.items || !Array.isArray(rawData.items) || rawData.items.length === 0) {
      return NextResponse.json(
        { error: 'Missing or invalid items array' },
        { status: 400 }
      )
    }

    if (typeof rawData.total !== 'number' || rawData.total <= 0) {
      return NextResponse.json(
        { error: 'Missing or invalid total' },
        { status: 400 }
      )
    }

    // REJECT legacy customer fields at root level
    const forbiddenRootFields = ['customer_email', 'customer_name', 'customer_phone', 'customerName', 'customerPhone', 'customerEmail']
    const foundForbidden = forbiddenRootFields.filter(field => field in rawData)
    if (foundForbidden.length > 0) {
      return NextResponse.json(
        { error: `Forbidden fields at root level: ${foundForbidden.join(', ')}. Use customer object instead.` },
        { status: 400 }
      )
    }

    // Get next order number
    const orderNumber = await getNextOrderNumber(rawData.restaurantId)

    // STEP 4: EXPLICIT ORDER OBJECT CONSTRUCTION
    // NO spread operators, NO pass-through, NO trusting request data
    
    // CRITICAL: Log incoming data to catch any customer_email
    console.log('🔍 INCOMING REQUEST DATA:', JSON.stringify(rawData, null, 2))
    console.log('🔍 Has customer_email in rawData?', 'customer_email' in rawData)
    console.log('🔍 Has customerEmail in rawData?', 'customerEmail' in rawData)
    if ('customer_email' in rawData || 'customerEmail' in rawData) {
      console.error('🚨 CRITICAL: customer_email found in incoming request!')
      return NextResponse.json(
        { error: 'Forbidden: customer_email field detected in request' },
        { status: 400 }
      )
    }
    
    const orderDoc = {
      // Required fields - explicitly set
      restaurant_id: String(rawData.restaurantId),
      order_number: Number(orderNumber),
      table_number: Number(rawData.tableNumber) || 0,
      
      // Customer object - explicitly constructed (NO customer_email possible)
      customer: {
        name: String(rawData.customer.name).trim(),
        phone: String(rawData.customer.phone).trim(),
      },
      
      // Status fields - hard-coded
      status: 'new' as const,
      payment_status: 'pending' as const,
      payment_method: String(rawData.paymentMethod || 'cash') as 'cash' | 'card' | 'mobile_money',
      
      // Pricing fields - explicitly converted
      subtotal: Number(rawData.subtotal) || 0,
      tax: Number(rawData.tax) || 0,
      service_fee: Number(rawData.service_fee) || 0,
      discount: Number(rawData.discount) || 0,
      tip: Number(rawData.tip) || 0,
      total: Number(rawData.total),
      
      // Order instructions - only if provided
      order_instructions: rawData.notes && String(rawData.notes).trim() ? String(rawData.notes).trim() : null,
      
      // Items - explicitly mapped
      items: (rawData.items || []).map((item: any) => ({
        menu_item_id: String(item.menuItemId || item.menu_item_id || ''),
        name: String(item.name || ''),
        quantity: Number(item.quantity) || 1,
        base_price: Number(item.basePrice || item.base_price || 0),
        subtotal: Number(item.subtotal || 0),
        special_instructions: String(item.specialInstructions || item.special_instructions || ''),
        selected_size: item.size || item.selected_size ? {
          name: String(item.size || item.selected_size?.name || ''),
          price_modifier: Number(item.selected_size?.price_modifier || 0),
        } : null,
        selected_addons: Array.isArray(item.addons) 
          ? item.addons.map((addon: any) => ({
              name: String(addon.name || ''),
              price: Number(addon.price || 0),
            }))
          : (Array.isArray(item.selected_addons) 
              ? item.selected_addons.map((addon: any) => ({
                  name: String(addon.name || ''),
                  price: Number(addon.price || 0),
                }))
              : []),
      })),
      
      // Timestamps - explicitly set
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // STEP 2 & 3: Guard and sanitize before Firestore write
    // This will throw error if customer_email exists anywhere
    // This will remove all undefined values recursively
    
    console.log('🔍 OrderDoc before guard:', JSON.stringify(orderDoc, null, 2))
    console.log('🔍 Has customer_email in orderDoc?', 'customer_email' in orderDoc)
    console.log('🔍 Has customerEmail in orderDoc?', 'customerEmail' in orderDoc)
    
    // CRITICAL: Check before guard
    if ('customer_email' in orderDoc || 'customerEmail' in orderDoc) {
      console.error('🚨 CRITICAL: customer_email found in orderDoc BEFORE guard!')
      throw new Error('FORBIDDEN: customer_email detected in orderDoc construction')
    }
    
    try {
      const cleanOrder = prepareForFirestore(orderDoc)
      console.log('✅ Guard passed - no forbidden fields')
      
      // CRITICAL: Double-check after guard
      if ('customer_email' in cleanOrder || 'customerEmail' in cleanOrder) {
        console.error('🚨 CRITICAL: customer_email found AFTER guard!')
        throw new Error('FORBIDDEN: customer_email detected after guard')
      }
      
      // CRITICAL: Check JSON string for customer_email
      const orderJson = JSON.stringify(cleanOrder)
      if (orderJson.includes('customer_email') || orderJson.includes('customerEmail')) {
        console.error('🚨 CRITICAL: customer_email found in JSON string!')
        console.error('🚨 Order JSON:', orderJson)
        throw new Error('FORBIDDEN: customer_email detected in JSON string')
      }
      
      console.log('📦 Final Firestore payload keys:', Object.keys(cleanOrder))
      console.log('📦 Final Firestore payload:', JSON.stringify(cleanOrder, null, 2))
      console.log('✅ No forbidden fields detected')
      console.log('✅ No undefined values detected')
      
      if (!db) {
        throw new Error('Firestore not initialized on server')
      }

      // FINAL NUCLEAR OPTION: Explicitly delete customer_email if it somehow exists
      // This should never happen, but we're being extra defensive
      if ('customer_email' in cleanOrder) {
        delete cleanOrder.customer_email
        console.error('🚨 DELETED customer_email that somehow appeared!')
      }
      if ('customerEmail' in cleanOrder) {
        delete cleanOrder.customerEmail
        console.error('🚨 DELETED customerEmail that somehow appeared!')
      }
      
      // FINAL CHECK: One more JSON check
      const finalJson = JSON.stringify(cleanOrder)
      if (finalJson.includes('customer_email') || finalJson.includes('customerEmail')) {
        console.error('🚨 CRITICAL: customer_email STILL EXISTS after all checks!')
        console.error('🚨 Final JSON:', finalJson)
        throw new Error('FORBIDDEN: customer_email still exists after all safeguards')
      }
      
      // Write to Firestore
      console.log('💾 Writing to Firestore...')
      const docRef = await addDoc(collection(db, 'orders'), cleanOrder)
      console.log('✅ Order written successfully:', docRef.id)
      
      return NextResponse.json({ orderId: docRef.id }, { status: 201 })
    } catch (guardError: any) {
      if (guardError.message && guardError.message.includes('FORBIDDEN FIELD DETECTED')) {
        console.error('🚨 GUARD ERROR:', guardError.message)
        return NextResponse.json(
          { error: guardError.message },
          { status: 400 }
        )
      }
      throw guardError
    }
    
    return NextResponse.json({ orderId: docRef.id }, { status: 201 })
  } catch (err: any) {
    console.error('ORDER CREATION FAILURE:', err)
    
    // If it's a forbidden field error, return 400
    if (err.message && err.message.includes('FORBIDDEN FIELD DETECTED')) {
      return NextResponse.json(
        { error: err.message },
        { status: 400 }
      )
    }
    
    return NextResponse.json(
      { error: err.message || 'Failed to create order' },
      { status: 500 }
    )
  }
}
