import { db } from '@/lib/firebase/config'
import { collection, addDoc } from 'firebase/firestore'
import { NextResponse } from 'next/server'
import { getNextOrderNumber } from '@/lib/firebase/orders'
import { assertNoForbiddenFields, removeUndefinedDeep, prepareForFirestore } from '@/lib/firebase/firestore-guards'

/**
 * SECURE ORDER CREATION API - STRICT VALIDATOR
 * 
 * This API route uses a whitelist approach:
 * - Only explicitly defined fields are included
 * - No spread operators
 * - Explicitly sets customer_email: null
 * - Server-side Firestore only
 */
export async function POST(req: Request) {
  try {
    console.log('🛡️ SECURITY: API Route - Order creation request received')
    
    const body = await req.json()
    
    // SECURITY CHECK: Reject if customer_email is in the request body
    if ('customer_email' in body || 'customerEmail' in body) {
      console.error('🚨 SECURITY: Malicious field detected in request body')
      return NextResponse.json(
        { error: 'Malicious field detected: customer_email is not allowed' },
        { status: 400 }
      )
    }
    
    // VALIDATION: Required fields
    if (!body.restaurantId || typeof body.restaurantId !== 'string') {
      return NextResponse.json(
        { error: 'restaurantId is required and must be a string' },
        { status: 400 }
      )
    }
    
    if (!body.customerName || typeof body.customerName !== 'string' || body.customerName.trim() === '') {
      return NextResponse.json(
        { error: 'customerName is required and must be a non-empty string' },
        { status: 400 }
      )
    }
    
    if (!body.customerPhone || typeof body.customerPhone !== 'string' || body.customerPhone.trim() === '') {
      return NextResponse.json(
        { error: 'customerPhone is required and must be a non-empty string' },
        { status: 400 }
      )
    }
    
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items is required and must be a non-empty array' },
        { status: 400 }
      )
    }
    
    if (typeof body.total !== 'number' || body.total <= 0) {
      return NextResponse.json(
        { error: 'total is required and must be a positive number' },
        { status: 400 }
      )
    }
    
    // Get next order number for this restaurant
    const orderNumber = await getNextOrderNumber(body.restaurantId)
    
    // WHITELIST APPROACH: Explicitly construct the Firestore document
    // NO spread operators, NO pass-through of request body
    const orderDoc = {
      restaurant_id: String(body.restaurantId),
      order_number: Number(orderNumber),
      table_number: Number(body.tableNumber) || 0,
      customer_name: String(body.customerName).trim(),
      customer_phone: String(body.customerPhone).trim(),
      customer_email: null, // Explicitly set to null (required constraint)
      status: 'new' as const,
      payment_status: 'pending' as const,
      payment_method: (body.paymentMethod === 'card' ? 'card' : 'cash') as 'cash' | 'card' | 'mobile_money',
      subtotal: Number(body.subtotal) || 0,
      tax: Number(body.tax) || 0,
      total: Number(body.total),
      order_instructions: body.orderInstructions && String(body.orderInstructions).trim() 
        ? String(body.orderInstructions).trim() 
        : null,
      items: (body.items || []).map((item: any) => ({
        menu_item_id: String(item.menuItemId || item.menu_item_id || ''),
        name: String(item.name || ''),
        quantity: Number(item.quantity) || 1,
        base_price: Number(item.basePrice || item.base_price || 0),
        subtotal: Number(item.subtotal || 0),
        size: item.size ? String(item.size) : null,
        addons: Array.isArray(item.addons) ? item.addons.map((a: any) => ({
          name: String(a.name || ''),
          price: Number(a.price || 0),
        })) : [],
        special_instructions: item.specialInstructions || item.special_instructions 
          ? String(item.specialInstructions || item.special_instructions).trim() 
          : null,
      })),
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    
    // FINAL SECURITY CHECK: Verify customer_email is null, not undefined
    if (orderDoc.customer_email !== null) {
      console.error('🚨 SECURITY: customer_email is not null!')
      return NextResponse.json(
        { error: 'Internal error: customer_email validation failed' },
        { status: 500 }
      )
    }
    
    // Apply Firestore guards: assert no forbidden fields and remove undefined
    const finalizedPayload = prepareForFirestore(orderDoc)
    
    // Explicitly delete customer_email if it somehow survived (extra defensive)
    if ('customer_email' in finalizedPayload) {
      delete (finalizedPayload as any).customer_email
      console.error('🚨 DELETED customer_email that somehow appeared!')
    }
    if ('customerEmail' in finalizedPayload) {
      delete (finalizedPayload as any).customerEmail
      console.error('🚨 DELETED customerEmail that somehow appeared!')
    }
    
    // Final JSON stringify/parse to ensure clean POJO
    const cleanPayload = JSON.parse(JSON.stringify(finalizedPayload))
    
    // One more explicit deletion after JSON round-trip
    if ('customer_email' in cleanPayload) {
      delete (cleanPayload as any).customer_email
    }
    if ('customerEmail' in cleanPayload) {
      delete (cleanPayload as any).customerEmail
    }
    
    // Explicitly set customer_email to null in final payload
    const finalOrderDoc = {
      ...cleanPayload,
      customer_email: null,
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log('📦 Final payload keys:', Object.keys(finalOrderDoc))
      console.log('📦 Has customer_email?', 'customer_email' in finalOrderDoc)
      console.log('📦 customer_email value:', finalOrderDoc.customer_email)
    }
    
    console.log('💾 Writing order to Firestore...')
    const docRef = await addDoc(collection(db!, 'orders'), finalOrderDoc)
    console.log('✅ Order created successfully:', docRef.id)
    
    return NextResponse.json({ orderId: docRef.id }, { status: 201 })
  } catch (err: any) {
    console.error('❌ ORDER CREATION FAILURE:', err)
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

