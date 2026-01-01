import { db } from '@/lib/firebase/config'
import { collection, addDoc } from 'firebase/firestore'
import { NextResponse } from 'next/server'
import { getNextOrderNumber } from '@/lib/firebase/orders'
import { assertNoForbiddenFields, removeUndefinedDeep, prepareForFirestore } from '@/lib/firebase/firestore-guards'
import { ordersPath } from '@/lib/firebase/paths'

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
    
    // STEP 5: HARD GUARD - Prevent Silent Failure
    // Reject invalid orders immediately
    // PART 1: session_id is now optional, but restaurantId and tableNumber are required
    if (!body.restaurantId || !body.items?.length) {
      console.error('🚨 ORDER REJECTED: Invalid order payload', {
        hasRestaurantId: !!body.restaurantId,
        hasTableNumber: !!body.tableNumber,
        hasItems: !!body.items?.length,
      })
      return NextResponse.json(
        { error: 'Invalid order payload: restaurantId, tableNumber, and items are required' },
        { status: 400 }
      )
    }
    
    // STEP 1: Fix Order Creation API - Explicit camelCase to snake_case mapping
    // PART 1: session_id is fetched from localStorage and attached to order
    // CRITICAL: Use Number() for table_number to ensure type matches database
    const sessionId = body.session_id ? String(body.session_id).trim() : undefined
    const restaurantId = String(body.restaurantId).trim()
    // CRITICAL: Use Number() to ensure table_number is stored as number (not string)
    const tableNumber = Number(body.tableNumber) || 0
    
    // Debugging: Add console logs that specify the type (e.g., typeof tableNumber) of the variables being used
    console.log('📦 API: Order payload received:', {
      sessionId: sessionId || 'none',
      sessionIdType: typeof sessionId,
      tableNumber,
      tableNumberType: typeof tableNumber,
      tableNumberValue: tableNumber,
      restaurantId,
      restaurantIdType: typeof restaurantId
    })
    
    // Validate tableNumber is provided and valid
    if (!body.tableNumber || tableNumber <= 0) {
      console.error('🚨 ORDER REJECTED: tableNumber is required and must be > 0')
      return NextResponse.json(
        { error: 'tableNumber is required and must be a positive number' },
        { status: 400 }
      )
    }
    
    // Validate required fields
    if (!restaurantId) {
      console.error('🚨 ORDER REJECTED: restaurantId is empty')
      return NextResponse.json(
        { error: 'restaurantId cannot be empty' },
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
    
    console.log('📦 API: Received order payload:', {
      restaurantId,
      sessionId,
      tableNumber,
      itemsCount: body.items.length,
      total: body.total,
    })
    
    // Get next order number for this restaurant
    const orderNumber = await getNextOrderNumber(restaurantId)
    
    // STEP 1: Fix Order Creation API - Explicit camelCase to snake_case mapping
    // Replace ALL usage of camelCase fields and explicitly map to Firestore snake_case
    const { serverTimestamp } = await import('firebase/firestore')
    
    const orderData = {
      // NEW: Remove restaurant_id from document (it's in the path)
      // restaurant_id: restaurantId, // REMOVED - now in path: restaurants/{id}/orders
      table_id: `table_${tableNumber}`, // Format: table_1, table_2, etc.
      // CRITICAL: Use Number() to ensure table_number is stored as number (not string)
      // Fix Order Saving: Ensure table_number is saved as a Number
      table_number: Number(tableNumber), // PART 1: Table number for banner queries
      // CRITICAL: Attach session_id to order so Active Order Banner can find it
      // Fix Order Saving: Ensure session_id is explicitly included in the order document so the banner works
      session_id: sessionId || null, // Attached from localStorage for banner queries
      
      // PART 2: Standardize Order Status Model
      // Use ONLY: new, accepted, preparing, ready, completed, cancelled
      status: 'new' as const, // Initial status when order is placed
      payment_status: 'pending' as const,
      table_closed: false, // PART 1: Track if table is closed (prevents order leakage)
      is_closed: false, // Task 1: Track if order is closed (table-based ordering)
      
      // ORDER CONTENT - Explicit mapping from camelCase
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
      
      // CRITICAL: Use Number() to ensure all numeric fields are stored as numbers
      subtotal: Number(body.subtotal) || 0,
      tax: Number(body.tax) || 0,
      total: Number(body.total), // Defensive: Ensure total is a number
      payment_method: (body.paymentMethod === 'card' ? 'card' : 'cash') as 'cash' | 'card' | 'mobile_money',
      order_instructions: body.orderInstructions && String(body.orderInstructions).trim() 
        ? String(body.orderInstructions).trim() 
        : null,
      
      // REQUIRED TIMESTAMPS - Both must exist
      created_at: serverTimestamp(),
      placed_at: serverTimestamp(), // REQUIRED for banner + dashboard queries
      
      source: 'qr_menu' as const,
      order_number: Number(orderNumber),
    }
    
    // STEP 1: JSON CAR WASH - NO UNDEFINED FIELDS
    // Apply Firestore guards: assert no forbidden fields and remove undefined
    const finalizedPayload = prepareForFirestore(orderData)
    
    // JSON Car Wash: Final stringify/parse to strip undefined values and ensure clean POJO
    const cleanOrder = JSON.parse(JSON.stringify(finalizedPayload))
    
    // STEP 5: HARD GUARD - Final validation before write
    // PART 1: Orders must have table_number and placed_at (restaurant_id is in path now)
    // session_id is optional (not required for banner logic)
    if (!cleanOrder.table_number || !cleanOrder.placed_at) {
      console.error('🚨 ORDER REJECTED: Missing required fields after sanitization', {
        hasTableNumber: !!cleanOrder.table_number,
        hasPlacedAt: !!cleanOrder.placed_at,
      })
      return NextResponse.json(
        { error: 'Order is missing required fields (table_number, placed_at)' },
        { status: 400 }
      )
    }
    
    // Validate status is canonical
    if (cleanOrder.status !== 'new') {
      console.error('🚨 ORDER REJECTED: Invalid status', cleanOrder.status)
      return NextResponse.json(
        { error: 'Order status must be "new"' },
        { status: 400 }
      )
    }
    
    // Debugging: Add console logs that specify the type of the variables being used
    console.log('💾 Writing canonical order to Firestore:', {
      restaurantId, // From variable, not document
      table_id: cleanOrder.table_id,
      table_number: cleanOrder.table_number,
      table_numberType: typeof cleanOrder.table_number,
      table_closed: cleanOrder.table_closed,
      session_id: cleanOrder.session_id || 'none (optional)',
      session_idType: typeof cleanOrder.session_id,
      status: cleanOrder.status,
      order_number: cleanOrder.order_number,
      order_numberType: typeof cleanOrder.order_number,
      has_placed_at: !!cleanOrder.placed_at,
      has_created_at: !!cleanOrder.created_at,
      items_count: cleanOrder.items?.length || 0,
    })
    
    // NEW: Use hierarchical path - restaurant_id is in the path
    const docRef = await addDoc(collection(db!, ordersPath(restaurantId)), cleanOrder)
    console.log('✅ Order created successfully:', docRef.id)
    console.log('✅ Order fields verified:', {
      restaurantId, // From variable
      table_number: cleanOrder.table_number,
      table_closed: cleanOrder.table_closed,
      session_id: cleanOrder.session_id || 'none (optional)',
      status: cleanOrder.status,
      placed_at: cleanOrder.placed_at ? 'present' : 'MISSING',
    })
    
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

