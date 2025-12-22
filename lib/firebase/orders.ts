import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from './config'
import { sanitizeFirestoreData } from './firestore-utils'

/**
 * Recursively removes customer_email from any object (including nested objects)
 * This is a nuclear option to ensure customer_email never reaches Firestore
 */
function removeCustomerEmailRecursive(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  
  if (Array.isArray(obj)) {
    return obj.map(item => removeCustomerEmailRecursive(item))
  }
  
  const cleaned: any = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'customer_email') {
      // Skip customer_email completely
      continue
    }
    cleaned[key] = removeCustomerEmailRecursive(value)
  }
  return cleaned
}

export interface OrderItem {
  menu_item_id: string
  name: string
  quantity: number
  base_price: number
  selected_size: { name: string; price_modifier: number } | null
  selected_addons: { name: string; price: number }[]
  special_instructions: string
  subtotal: number
}

export interface Order {
  id: string
  order_number: number
  restaurant_id: string
  table_id: string
  table_number: number
  customer_name?: string
  customer_phone?: string
  items: OrderItem[]
  order_instructions?: string
  subtotal: number
  tax: number
  service_fee: number
  discount: number
  tip: number
  total: number
  payment_method: 'cash' | 'card' | 'mobile_money'
  payment_status: 'pending' | 'paid' | 'failed'
  paid_at?: any
  status: 'new' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled'
  placed_at: any
  accepted_at?: any
  preparing_at?: any
  ready_at?: any
  completed_at?: any
  cancelled_at?: any
  prep_time_minutes?: number
  created_at: any
  updated_at: any
}

// Get next order number for a restaurant
export async function getNextOrderNumber(restaurantId: string): Promise<number> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'orders'),
      where('restaurant_id', '==', restaurantId),
      orderBy('order_number', 'desc'),
      limit(1)
    )
    
    const snapshot = await getDocs(q)
    if (snapshot.empty) return 1
    
    const lastOrder = snapshot.docs[0].data() as Order
    return lastOrder.order_number + 1
  } catch (error: any) {
    // If orderBy fails (no index), return 1
    return 1
  }
}

// Create a new order
export async function createOrder(data: Omit<Order, 'id' | 'order_number' | 'created_at' | 'updated_at'>): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get next order number
    const orderNumber = await getNextOrderNumber(data.restaurant_id)
    
    // CRITICAL: Remove customer_email and any undefined values from input data
    // Convert to plain object and explicitly remove customer_email
    const dataObj = data as any
    const cleanData: any = {}
    
    // Copy only allowed fields, explicitly excluding customer_email
    const allowedFields = [
      'restaurant_id', 'table_id', 'table_number', 'items',
      'subtotal', 'tax', 'service_fee', 'discount', 'tip', 'total',
      'payment_method', 'payment_status', 'status',
      'customer_name', 'customer_phone', 'order_instructions'
    ]
    
    for (const key of allowedFields) {
      if (key in dataObj && dataObj[key] !== undefined) {
        cleanData[key] = dataObj[key]
      }
    }
    
    // Explicitly verify customer_email is NOT in cleanData
    if ('customer_email' in cleanData) {
      console.error('ERROR: customer_email found in cleanData after filtering!')
      delete cleanData.customer_email
    }
    
    // Helper function to safely get string value or null (never undefined)
    const safeString = (value: any): string | null => {
      if (value === undefined || value === null) return null
      const str = String(value).trim()
      return str !== '' ? str : null
    }
    
    // Build order document from scratch - ONLY include fields we explicitly want
    // This ensures NO undefined values can slip through
    const orderDoc: Record<string, any> = {
      // Required fields (always present)
      restaurant_id: String(cleanData.restaurant_id),
      table_id: String(cleanData.table_id || ''),
      table_number: Number(cleanData.table_number) || 0,
      items: Array.isArray(cleanData.items) ? cleanData.items : [],
      subtotal: Number(cleanData.subtotal) || 0,
      tax: Number(cleanData.tax) || 0,
      service_fee: Number(cleanData.service_fee) || 0,
      discount: Number(cleanData.discount) || 0,
      tip: Number(cleanData.tip) || 0,
      total: Number(cleanData.total) || 0,
      payment_method: String(cleanData.payment_method || 'cash'),
      payment_status: String(cleanData.payment_status || 'pending'),
      status: String(cleanData.status || 'new'),
      order_number: Number(orderNumber),
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    
    // Optional fields: only add if they have valid values, otherwise omit entirely
    // Using null is Firestore-safe, but we'll use the sanitizer to remove undefined
    const customerName = safeString(cleanData.customer_name)
    if (customerName !== null) {
      orderDoc.customer_name = customerName
    }
    
    const customerPhone = safeString(cleanData.customer_phone)
    if (customerPhone !== null) {
      orderDoc.customer_phone = customerPhone
    }
    
    const orderInstructions = safeString(cleanData.order_instructions)
    if (orderInstructions !== null) {
      orderDoc.order_instructions = orderInstructions
    }
    
    // === COMPREHENSIVE DEBUG LOGGING ===
    console.log('=== ORDER DATA DEBUG ===')
    console.log('Input data keys:', Object.keys(data))
    console.log('Input data has customer_email?', 'customer_email' in data)
    console.log('CleanData keys:', Object.keys(cleanData))
    console.log('CleanData has customer_email?', 'customer_email' in cleanData)
    console.log('ORDER PAYLOAD BEFORE SANITIZATION →', orderDoc)
    console.log('OrderDoc keys:', Object.keys(orderDoc))
    console.log('OrderDoc has customer_email?', 'customer_email' in orderDoc)
    console.log('Has undefined values?', Object.values(orderDoc).some(v => v === undefined))
    console.log('Undefined fields:', Object.entries(orderDoc).filter(([_, v]) => v === undefined).map(([k]) => k))
    console.log('========================')
    
    // CRITICAL: Sanitize before Firestore write - removes any undefined values
    const cleanedOrderDoc = sanitizeFirestoreData(orderDoc)
    
    // EXPLICIT: Remove customer_email if it somehow still exists
    if ('customer_email' in cleanedOrderDoc) {
      console.warn('WARNING: customer_email found in cleanedOrderDoc, removing it')
      delete (cleanedOrderDoc as any).customer_email
    }
    
    // Final validation - ensure no undefined values
    const hasUndefined = Object.values(cleanedOrderDoc).some(v => v === undefined)
    if (hasUndefined) {
      console.error('ERROR: Undefined values still present after sanitization:', cleanedOrderDoc)
      console.error('Problematic fields:', Object.entries(cleanedOrderDoc).filter(([_, v]) => v === undefined))
      throw new Error('Order data contains undefined values after sanitization')
    }
    
    // Final debug before Firestore write
    console.log('=== FINAL ORDER PAYLOAD ===')
    console.log('ORDER PAYLOAD AFTER SANITIZATION →', cleanedOrderDoc)
    console.log('Final keys:', Object.keys(cleanedOrderDoc))
    console.log('Has customer_email?', 'customer_email' in cleanedOrderDoc)
    console.log('Final check - Has undefined values?', Object.values(cleanedOrderDoc).some(v => v === undefined))
    console.log('All field types:', Object.entries(cleanedOrderDoc).map(([k, v]) => `${k}: ${typeof v}${v === undefined ? ' (UNDEFINED!)' : ''}`))
    console.log('==========================')
    
    // NUCLEAR OPTION: Build final document from scratch with ONLY allowed fields
    // This is the most reliable way - we explicitly list every field we want
    const finalOrderDoc: Record<string, any> = {
      restaurant_id: cleanedOrderDoc.restaurant_id,
      table_id: cleanedOrderDoc.table_id,
      table_number: cleanedOrderDoc.table_number,
      items: cleanedOrderDoc.items,
      subtotal: cleanedOrderDoc.subtotal,
      tax: cleanedOrderDoc.tax,
      service_fee: cleanedOrderDoc.service_fee,
      discount: cleanedOrderDoc.discount,
      tip: cleanedOrderDoc.tip,
      total: cleanedOrderDoc.total,
      payment_method: cleanedOrderDoc.payment_method,
      payment_status: cleanedOrderDoc.payment_status,
      status: cleanedOrderDoc.status,
      order_number: cleanedOrderDoc.order_number,
      placed_at: cleanedOrderDoc.placed_at,
      created_at: cleanedOrderDoc.created_at,
      updated_at: cleanedOrderDoc.updated_at,
    }
    
    // Only add optional fields if they exist and are not undefined
    if (cleanedOrderDoc.customer_name !== undefined) {
      finalOrderDoc.customer_name = cleanedOrderDoc.customer_name
    }
    if (cleanedOrderDoc.customer_phone !== undefined) {
      finalOrderDoc.customer_phone = cleanedOrderDoc.customer_phone
    }
    if (cleanedOrderDoc.order_instructions !== undefined) {
      finalOrderDoc.order_instructions = cleanedOrderDoc.order_instructions
    }
    
    // EXPLICIT: customer_email is NEVER added - it doesn't exist in finalOrderDoc
    
    // Final sanitization pass - remove any undefined that might have slipped through
    const sanitizedFinal = sanitizeFirestoreData(finalOrderDoc)
    
    // Final explicit check - ensure customer_email is not present
    if ('customer_email' in sanitizedFinal) {
      console.error('CRITICAL ERROR: customer_email found in final document!')
      delete (sanitizedFinal as any).customer_email
    }
    
    // NUCLEAR OPTION: Recursively remove customer_email from entire object (including nested)
    const finalCleaned = removeCustomerEmailRecursive(sanitizedFinal)
    
    // Final validation - ensure no undefined and no customer_email
    const hasUndefined = Object.values(finalCleaned).some(v => v === undefined)
    const hasCustomerEmail = 'customer_email' in finalCleaned
    
    if (hasUndefined || hasCustomerEmail) {
      console.error('CRITICAL ERROR: Final document still has issues!')
      console.error('Has undefined?', hasUndefined)
      console.error('Has customer_email?', hasCustomerEmail)
      console.error('Document:', finalCleaned)
      throw new Error(`Order data is invalid: ${hasUndefined ? 'undefined values' : ''} ${hasCustomerEmail ? 'customer_email present' : ''}`)
    }
    
    console.log('=== NUCLEAR SANITIZED PAYLOAD ===')
    console.log('Final order doc:', finalCleaned)
    console.log('Final keys:', Object.keys(finalCleaned))
    console.log('Has customer_email?', 'customer_email' in finalCleaned)
    console.log('Has undefined?', Object.values(finalCleaned).some(v => v === undefined))
    console.log('All values:', Object.entries(finalCleaned).map(([k, v]) => `${k}: ${v === undefined ? 'UNDEFINED!' : typeof v}`))
    console.log('=================================')
    
    const docRef = await addDoc(collection(db, 'orders'), finalCleaned)
    
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create order')
  }
}

// Get orders for a restaurant with status filter
export async function getOrders(
  restaurantId: string,
  status?: Order['status']
): Promise<Order[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    let q = query(
      collection(db, 'orders'),
      where('restaurant_id', '==', restaurantId),
      orderBy('placed_at', 'desc')
    )
    
    if (status) {
      q = query(q, where('status', '==', status))
    }
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order))
  } catch (error: any) {
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      const indexUrlMatch = error.message?.match(/https:\/\/[^\s]+/)
      const indexUrl = indexUrlMatch ? indexUrlMatch[0] : null
      console.error(
        'Firestore index required for orders query. ' +
        'Please create the index using the link in the error message, ' +
        'or deploy firestore.indexes.json using: firebase deploy --only firestore:indexes'
      )
      if (indexUrl) {
        console.error('Index creation URL:', indexUrl)
      }
      throw new Error(
        'Firestore index required. Please create the required index. ' +
        'See the console for the index creation URL or deploy firestore.indexes.json.'
      )
    }
    throw new Error(error.message || 'Failed to fetch orders')
  }
}

// Get a single order
export async function getOrder(orderId: string): Promise<Order | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'orders', orderId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as Order
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch order')
  }
}

// Update order status
export async function updateOrderStatus(
  orderId: string,
  status: Order['status']
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'orders', orderId)
    const updates: any = {
      status,
      updated_at: new Date().toISOString(),
    }
    
    // Set timestamp based on status
    const now = new Date().toISOString()
    switch (status) {
      case 'accepted':
        updates.accepted_at = now
        break
      case 'preparing':
        updates.preparing_at = now
        break
      case 'ready':
        updates.ready_at = now
        // Calculate prep time if accepted_at exists
        const order = await getOrder(orderId)
        if (order?.accepted_at) {
          const acceptedTime = new Date(order.accepted_at).getTime()
          const readyTime = new Date().getTime()
          updates.prep_time_minutes = Math.round((readyTime - acceptedTime) / 60000)
        }
        break
      case 'completed':
        updates.completed_at = now
        break
      case 'cancelled':
        updates.cancelled_at = now
        break
    }
    
    await updateDoc(docRef, updates)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update order status')
  }
}

// Update order payment status
export async function updateOrderPayment(
  orderId: string,
  paymentStatus: Order['payment_status'],
  staffId?: string
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'orders', orderId)
    
    // Check if order is already paid
    const orderDoc = await getDoc(docRef)
    if (!orderDoc.exists()) {
      throw new Error('Order not found')
    }
    
    const currentOrder = orderDoc.data() as Order
    if (currentOrder.payment_status === 'paid' && paymentStatus === 'paid') {
      throw new Error('Order is already marked as paid')
    }
    
    const updates: any = {
      payment_status: paymentStatus,
      updated_at: new Date().toISOString(),
    }
    
    if (paymentStatus === 'paid') {
      updates.paid_at = new Date().toISOString()
      if (staffId) {
        updates.paid_by_staff_id = staffId
      }
    }
    
    await updateDoc(docRef, updates)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update payment status')
  }
}

// Subscribe to orders (real-time)
export function subscribeToOrders(
  restaurantId: string,
  status: Order['status'],
  callback: (orders: Order[]) => void
): () => void {
  if (!db) {
    callback([])
    return () => {}
  }
  
  try {
    const q = query(
      collection(db, 'orders'),
      where('restaurant_id', '==', restaurantId),
      where('status', '==', status),
      orderBy('placed_at', 'desc')
    )
    
    return onSnapshot(
      q,
      (snapshot) => {
        const orders = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
        } as Order))
        callback(orders)
      },
      (error: any) => {
        console.error('Error in orders snapshot listener:', error)
        
        // Check if it's a missing index error
        if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
          console.error(
            'Firestore index required. Please create the index using the link in the error message, ' +
            'or deploy firestore.indexes.json using: firebase deploy --only firestore:indexes'
          )
          
          // Extract the index creation URL if available
          const indexUrlMatch = error.message?.match(/https:\/\/[^\s]+/)
          if (indexUrlMatch) {
            console.error('Index creation URL:', indexUrlMatch[0])
          }
        }
        
        callback([])
      }
    )
  } catch (error: any) {
    console.error('Error setting up orders subscription:', error)
    
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      console.error(
        'Firestore index required. Please create the index using the link in the error message, ' +
        'or deploy firestore.indexes.json using: firebase deploy --only firestore:indexes'
      )
    }
    
    callback([])
    return () => {}
  }
}

// Subscribe to a single order (real-time)
export function subscribeToOrder(
  orderId: string,
  callback: (order: Order | null) => void
): () => void {
  if (!db) {
    callback(null)
    return () => {}
  }
  
  try {
    const docRef = doc(db, 'orders', orderId)
    
    return onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        callback({ id: docSnap.id, ...docSnap.data() } as Order)
      } else {
        callback(null)
      }
    })
  } catch (error: any) {
    console.error('Error subscribing to order:', error)
    callback(null)
    return () => {}
  }
}

