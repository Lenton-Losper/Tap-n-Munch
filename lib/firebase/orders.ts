import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from './config'
import { sanitizeFirestoreData } from './firestore-utils'
import { ordersPath, orderPath } from './paths'

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
  session_id?: string | null
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
  payment_method: 'cash' | 'card' | 'mobile_money' | 'card_terminal'
  /** Finatic: hosted checkout vs physical terminal (card + terminal). */
  payment_channel?: 'hosted' | 'terminal' | null
  /** Set when customer requests terminal (see ready-for-terminal API). */
  ready_for_terminal_at?: string | null
  payment_status: 'pending' | 'cash_pending' | 'terminal_pending' | 'paid' | 'failed'
  paid_at?: any
  status:
    | 'new'
    | 'accepted'
    | 'preparing'
    | 'ready'
    | 'ready_for_terminal'
    | 'completed'
    | 'cancelled'
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
    // NEW: Use hierarchical path - restaurant_id is in the path
    const q = query(
      collection(db, ordersPath(restaurantId)),
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
    // NEW: Use hierarchical path - restaurant_id is in the path
    let q = query(
      collection(db, ordersPath(restaurantId)),
      orderBy('placed_at', 'desc')
    )
    
    if (status) {
      q = query(q, where('status', '==', status))
    }
    
    const snapshot = await getDocs(q)
    const { normalizeOrder } = require('@/lib/utils')
    return snapshot.docs.map(doc => {
      const data = doc.data()
      return normalizeOrder({
        id: doc.id,
        ...data,
      }) as Order
    })
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
export async function getOrder(restaurantId: string, orderId: string, sessionId?: string): Promise<Order | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // NEW: Use hierarchical path
    const docRef = doc(db, orderPath(restaurantId, orderId))
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      const { normalizeOrder } = require('@/lib/utils')
      const data = docSnap.data()
      const order = normalizeOrder({
        id: docSnap.id,
        ...data,
      }) as Order
      
      // If sessionId is provided, verify it matches the order's session_id
      if (sessionId && order.session_id && order.session_id !== sessionId) {
        console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch:', {
          providedSessionId: sessionId,
          orderSessionId: order.session_id,
          orderId: orderId
        })
        return null // Order exists but doesn't belong to this session
      }
      
      return order
    }
    return null
  } catch (error: any) {
    // Check for permission errors
    if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
      console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied:', {
        error: error.message,
        code: error.code,
        restaurantId,
        orderId,
        sessionId: sessionId || 'not provided'
      })
      throw new Error('Permission denied: Order not found or session mismatch')
    }
    throw new Error(error.message || 'Failed to fetch order')
  }
}

// Get order by ID with session verification (query-based for security)
export async function getOrderByIdWithSession(
  restaurantId: string,
  orderId: string,
  sessionId: string
): Promise<Order | null> {
  if (!db) throw new Error('Firestore is not initialized')
  if (!sessionId) {
    console.error('❌ [CONFIRMATION ERROR] Session ID required for secure order lookup')
    return null
  }
  
  try {
    // Query by orderId AND session_id to ensure security rules pass
    const ordersRef = collection(db, ordersPath(restaurantId))
    const q = query(
      ordersRef,
      where('__name__', '==', orderId), // Match document ID
      where('session_id', '==', sessionId) // Match session
    )
    
    const snapshot = await getDocs(q)
    
    if (snapshot.empty) {
      console.warn('⚠️ [CONFIRMATION] Order not found or session mismatch:', {
        orderId,
        sessionId,
        restaurantId
      })
      return null
    }
    
    const { normalizeOrder } = require('@/lib/utils')
    const orderDoc = snapshot.docs[0]
    const data = orderDoc.data()
    return normalizeOrder({
      id: orderDoc.id,
      ...data,
    }) as Order
  } catch (error: any) {
    // Check for permission errors
    if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
      console.error('❌ [CONFIRMATION ERROR] Session ID Mismatch or Permission Denied:', {
        error: error.message,
        code: error.code,
        restaurantId,
        orderId,
        sessionId
      })
      throw new Error('Permission denied: Order not found or session mismatch')
    }
    
    // Fallback to direct document lookup if query fails (e.g., __name__ not supported)
    console.warn('⚠️ [CONFIRMATION] Query-based lookup failed, falling back to direct lookup:', error.message)
    return getOrder(restaurantId, orderId, sessionId)
  }
}

// Update order status
export async function updateOrderStatus(
  restaurantId: string,
  orderId: string,
  status: Order['status']
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  if (!restaurantId) throw new Error('Restaurant ID is required')
  
  try {
    // Use hierarchical path: restaurants/{restaurantId}/orders/{orderId}
    const docRef = doc(db, orderPath(restaurantId, orderId))
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
        const order = await getOrder(restaurantId, orderId)
        if (order?.accepted_at) {
          const acceptedTime = order.accepted_at instanceof Date 
            ? order.accepted_at.getTime() 
            : new Date(order.accepted_at).getTime()
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
    console.error('❌ [updateOrderStatus] Error updating order:', {
      restaurantId,
      orderId,
      status,
      errorCode: error.code,
      errorMessage: error.message,
    })
    throw new Error(error.message || 'Failed to update order status')
  }
}

// Update order payment status
export async function updateOrderPayment(
  restaurantId: string,
  orderId: string,
  paymentStatus: Order['payment_status'],
  staffId?: string
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  if (!restaurantId) throw new Error('Restaurant ID is required')
  
  try {
    // Use hierarchical path: restaurants/{restaurantId}/orders/{orderId}
    const docRef = doc(db, orderPath(restaurantId, orderId))
    
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
    console.error('❌ [updateOrderPayment] Error updating payment:', {
      restaurantId,
      orderId,
      paymentStatus,
      errorCode: error.code,
      errorMessage: error.message,
    })
    throw new Error(error.message || 'Failed to update payment status')
  }
}

// Subscribe to orders (real-time)
/**
 * PART 5: Fix Dashboard Query (Restaurant View)
 * 
 * Dashboard must NOT filter by session.
 * Query: restaurant_id + status in [pending, accepted, preparing, ready] + orderBy placed_at
 */
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
    // STEP 3: Fix Dashboard Query (Match Reality)
    // Dashboard = restaurant-wide view, NO session filter
    // NEW: Use hierarchical path - restaurant_id is in the path
    const q = query(
      collection(db, ordersPath(restaurantId)),
      where('status', '==', status),
      orderBy('placed_at', 'asc') // Use 'asc' for chronological order (oldest first)
    )
    
    console.log('🔍 subscribeToOrders: Querying for restaurant_id:', restaurantId, 'status:', status)
    
    // DEBUG: Also check if ANY orders exist for this restaurant (regardless of status)
    const debugQuery = query(
      collection(db, ordersPath(restaurantId)),
      limit(5)
    )
    
    getDocs(debugQuery).then((debugSnapshot) => {
      console.log('🔍 DEBUG: Total orders for restaurant', restaurantId, ':', debugSnapshot.docs.length)
      if (debugSnapshot.docs.length > 0) {
        debugSnapshot.docs.forEach((doc, idx) => {
          const data = doc.data()
          console.log(`🔍 DEBUG: Order ${idx + 1}:`, {
            id: doc.id,
            status: data.status,
            restaurant_id: data.restaurant_id,
            has_placed_at: !!data.placed_at,
            has_created_at: !!data.created_at,
            has_session_id: !!data.session_id,
            order_number: data.order_number,
          })
        })
      } else {
        console.log('⚠️ DEBUG: No orders found for this restaurant at all. Either no orders exist, or restaurant_id mismatch.')
      }
    }).catch((err) => {
      console.error('⚠️ DEBUG: Error checking all orders:', err)
    })
    
    return onSnapshot(
      q,
      (snapshot) => {
        console.log('📦 subscribeToOrders: Snapshot received,', snapshot.docs.length, 'orders found')
        if (snapshot.docs.length > 0) {
          const firstDoc = snapshot.docs[0]
          const firstData = firstDoc.data()
          console.log('📦 subscribeToOrders: First order sample:', {
            id: firstDoc.id,
            order_number: firstData.order_number,
            status: firstData.status,
            restaurant_id: firstData.restaurant_id,
            table_id: firstData.table_id,
            session_id: firstData.session_id,
            created_at: firstData.created_at,
            placed_at: firstData.placed_at,
          })
        } else {
          // PART 5: Safety Logging - Log all statuses found for this restaurant
          console.log('⚠️ subscribeToOrders: No orders found. Possible reasons:')
          console.log('  1. No orders exist with status:', status)
          console.log('  2. Orders exist but have different status')
          console.log('  3. Orders exist but missing placed_at field')
          console.log('  4. Orders exist but restaurant_id mismatch')
          console.log('📊 Query parameters used:', {
            restaurant_id: restaurantId,
            status: status,
            orderBy: 'placed_at',
          })
        }
        
        const { normalizeOrder } = require('@/lib/utils')
        const orders = snapshot.docs.map(doc => {
          const data = doc.data()
          return normalizeOrder({
            id: doc.id,
            ...data,
          }) as Order
        })
        callback(orders)
      },
      (error: any) => {
        console.error('❌ Error in orders snapshot listener:', error)
        
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
  restaurantId: string,
  orderId: string,
  callback: (order: Order | null) => void
): () => void {
  if (!db) {
    callback(null)
    return () => {}
  }

  try {
    const docRef = doc(db, orderPath(restaurantId, orderId))

    return onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const { normalizeOrder } = require('@/lib/utils')
        const data = docSnap.data()
        callback(
          normalizeOrder({
            id: docSnap.id,
            ...data,
          }) as Order
        )
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

