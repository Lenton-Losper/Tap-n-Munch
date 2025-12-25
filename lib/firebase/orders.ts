import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from './config'
import { sanitizeFirestoreData } from './firestore-utils'

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
  customer: {
    name: string
    phone: string
  }
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
// COMPLETELY DECOUPLED: No Firebase imports - just a fetch wrapper
// The browser's Firebase SDK never sees this data, preventing client-side validation errors
// CRITICAL: JSON.parse(JSON.stringify()) is the only 100% effective way to strip undefined keys
export async function createOrder(orderData: any): Promise<string> {
  console.log('🚀 API BRIDGE EXECUTING')
  
  // CRITICAL: Strip undefined values before sending
  // This physically removes any keys with undefined values from the object
  const cleanData = JSON.parse(JSON.stringify(orderData))
  
  // Explicitly ensure forbidden field is gone (defensive)
  if ('customer_email' in cleanData) {
    delete cleanData.customer_email
  }
  if ('customerEmail' in cleanData) {
    delete cleanData.customerEmail
  }
  
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleanData),
  })
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || 'Order failed at the server level')
  }
  
  const result = await response.json()
  return result.orderId
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

