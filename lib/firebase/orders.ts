import { collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, doc, getDoc, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from './config'
import { sanitizeFirestoreData } from './firestore-utils'
import { ordersPath, orderPath } from './paths'
import { supabase } from '@/lib/supabase/client'

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
  if (!restaurantId) throw new Error('Restaurant ID is required')
  const supabaseAny = supabase as any
  
  try {
    const updates: Record<string, unknown> = {
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
        const { data: existingOrder } = await supabaseAny
          .from('orders')
          .select('accepted_at')
          .eq('id', orderId)
          .eq('firebase_restaurant_id', restaurantId)
          .single()
        const acceptedAt = (existingOrder as { accepted_at?: string } | null)?.accepted_at
        if (acceptedAt) {
          const acceptedTime = new Date(acceptedAt).getTime()
          const readyTime = new Date().getTime()
          if (Number.isFinite(acceptedTime)) {
            updates.prep_time_minutes = Math.round((readyTime - acceptedTime) / 60000)
          }
        }
        break
      case 'completed':
        updates.completed_at = now
        break
      case 'cancelled':
        updates.cancelled_at = now
        break
    }
    
    const { error } = await supabaseAny
      .from('orders')
      .update(updates)
      .eq('id', orderId)
      .eq('firebase_restaurant_id', restaurantId)
    if (error) throw error
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
  if (!restaurantId) throw new Error('Restaurant ID is required')
  const supabaseAny = supabase as any
  
  try {
    const { data: currentOrder, error: orderError } = await supabaseAny
      .from('orders')
      .select('payment_status')
      .eq('id', orderId)
      .eq('firebase_restaurant_id', restaurantId)
      .single()
    if (orderError || !currentOrder) {
      throw new Error('Order not found')
    }
    if ((currentOrder as { payment_status?: string }).payment_status === 'paid' && paymentStatus === 'paid') {
      throw new Error('Order is already marked as paid')
    }
    
    const updates: Record<string, unknown> = {
      payment_status: paymentStatus,
      updated_at: new Date().toISOString(),
    }
    
    if (paymentStatus === 'paid') {
      updates.paid_at = new Date().toISOString()
      if (staffId) {
        updates.paid_by_staff_id = staffId
      }
    }
    
    const { error } = await supabaseAny
      .from('orders')
      .update(updates)
      .eq('id', orderId)
      .eq('firebase_restaurant_id', restaurantId)
    if (error) throw error
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
  status: string,
  callback: (orders: Order[]) => void
): () => void {
  const fetchOrders = async () => {
    let queryBuilder = supabase
      .from('orders')
      .select('*')
      .eq('firebase_restaurant_id', restaurantId)
      .order('placed_at', { ascending: true })

    if (status === 'new') {
      queryBuilder = queryBuilder.in('status', ['new', 'ready_for_terminal'])
    } else if (status === 'completed') {
      queryBuilder = queryBuilder.in('status', ['completed']).or('payment_status.eq.paid')
    } else {
      queryBuilder = queryBuilder.eq('status', status)
    }

    if (status !== 'completed') {
      queryBuilder = queryBuilder.eq('is_closed', false)
    }

    const { data, error } = await queryBuilder
    if (error) {
      console.error('[SUPABASE] subscribeToOrders error:', error)
      callback([])
      return
    }
    const { normalizeOrder } = require('@/lib/utils')
    const normalized = (data || []).map((row: any) => normalizeOrder(row) as Order)
    console.log(`[SUPABASE] ${status} orders:`, normalized.length)
    callback(normalized)
  }

  fetchOrders().catch((err) => {
    console.error('[SUPABASE] subscribeToOrders fetch failed:', err)
    callback([])
  })

  const channel = supabase
    .channel(`orders-${restaurantId}-${status}-${Date.now()}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `firebase_restaurant_id=eq.${restaurantId}`
      },
      (payload) => {
        console.log('[SUPABASE] Realtime change:', payload.eventType)
        fetchOrders().catch((err) => {
          console.error('[SUPABASE] subscribeToOrders refresh failed:', err)
          callback([])
        })
      }
    )
    .subscribe((channelStatus) => {
      console.log('[SUPABASE] Subscription status:', channelStatus)
    })

  return () => {
    supabase.removeChannel(channel)
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

