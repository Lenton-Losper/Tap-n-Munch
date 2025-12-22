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
    
    // Extract data and ensure customer_email is removed
    const dataObj = data as any
    const { customer_email, ...cleanInput } = dataObj
    
    // Collect all order data (may contain undefined values)
    const rawOrderData: Record<string, any> = {
      restaurant_id: String(cleanInput.restaurant_id || ''),
      table_id: String(cleanInput.table_id || ''),
      table_number: Number(cleanInput.table_number) || 0,
      items: Array.isArray(cleanInput.items) ? cleanInput.items : [],
      subtotal: Number(cleanInput.subtotal) || 0,
      tax: Number(cleanInput.tax) || 0,
      service_fee: Number(cleanInput.service_fee) || 0,
      discount: Number(cleanInput.discount) || 0,
      tip: Number(cleanInput.tip) || 0,
      total: Number(cleanInput.total) || 0,
      payment_method: String(cleanInput.payment_method || 'cash'),
      payment_status: String(cleanInput.payment_status || 'pending'),
      status: String(cleanInput.status || 'new'),
      order_number: Number(orderNumber),
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Optional fields (may be undefined)
      customer_name: cleanInput.customer_name,
      customer_phone: cleanInput.customer_phone,
      order_instructions: cleanInput.order_instructions,
    }
    
    // Remove all undefined fields before sending to Firestore
    // This ensures NO undefined values reach Firestore
    const orderData: Record<string, any> = {}
    Object.keys(rawOrderData).forEach(key => {
      const value = rawOrderData[key]
      // Skip undefined values and customer_email (legacy field, no longer used)
      if (value !== undefined && key !== 'customer_email') {
        orderData[key] = value
      }
    })
    
    // Defensive logging
    console.log('📦 Submitting order:', orderData)
    console.log('Has undefined?', Object.values(orderData).some(v => v === undefined))
    console.log('Has customer_email?', 'customer_email' in orderData)
    
    // Final validation
    const hasUndefined = Object.values(orderData).some(v => v === undefined)
    const hasCustomerEmail = 'customer_email' in orderData
    
    if (hasUndefined || hasCustomerEmail) {
      console.error('❌ CRITICAL ERROR: Order data is invalid!')
      console.error('Has undefined?', hasUndefined)
      console.error('Has customer_email?', hasCustomerEmail)
      throw new Error(`Order data is invalid: ${hasUndefined ? 'undefined values' : ''} ${hasCustomerEmail ? 'customer_email present' : ''}`)
    }
    
    const docRef = await addDoc(collection(db, 'orders'), orderData)
    console.log('✅ Order created successfully! ID:', docRef.id)
    
    return docRef.id
  } catch (error: any) {
    console.error('❌ Failed to place order:', error)
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

