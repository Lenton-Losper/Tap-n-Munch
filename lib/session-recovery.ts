/**
 * PART 1: Table-Based Session Recovery
 * 
 * Safely restores session from active table orders when customer rescans QR.
 * Prevents order leakage between customers.
 */

import { collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'

const SESSION_KEY = 'flashtap_session_v1'

/**
 * Restore session from active table orders
 * 
 * Rules:
 * - Only restore if EXACTLY ONE active session exists for this table
 * - Do NOT restore if multiple sessions (prevents leakage)
 * - Do NOT restore if no active orders
 * - Only restore active statuses: new, accepted, preparing, ready
 */
export async function restoreSessionFromTable(
  restaurantId: string,
  tableNumber: number
): Promise<string | null> {
  if (typeof window === 'undefined') return null

  // Check if session already exists
  const existingSession = localStorage.getItem(SESSION_KEY)
  if (existingSession) {
    console.log('✅ Session already exists, skipping recovery:', existingSession)
    return existingSession
  }

  if (!db) {
    console.warn('⚠️ Firestore not initialized, cannot recover session')
    return null
  }

  try {
    console.log('🔍 PART 1: Running session recovery check for table', tableNumber)

    // Query Firestore for active orders for this table
    // NEW: Use hierarchical path - restaurant_id is in the path
    const { ordersPath } = require('./firebase/paths')
    const ordersRef = collection(db, ordersPath(restaurantId))
    
    // Query by table_number + active statuses
    // NEW: restaurant_id is in the path, no need to filter
    const q = query(
      ordersRef,
      where('table_number', '==', tableNumber),
      where('status', 'in', ['new', 'accepted', 'preparing', 'ready']),
      where('table_closed', '==', false)
    )

    const snapshot = await getDocs(q)
    const orders = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }))

    console.log('📦 Recovery: Found', orders.length, 'active orders for table', tableNumber)

    if (orders.length === 0) {
      console.log('📭 Recovery: No active orders found - table is clear, no session to restore')
      return null
    }

    // Group orders by session_id
    const sessionGroups = new Map<string, number>()
    orders.forEach(order => {
      const sessionId = order.session_id
      if (sessionId) {
        sessionGroups.set(sessionId, (sessionGroups.get(sessionId) || 0) + 1)
      }
    })

    const uniqueSessions = Array.from(sessionGroups.keys())
    console.log('📊 Recovery: Found', uniqueSessions.length, 'unique session(s):', uniqueSessions)

    // PART 1: Only restore if EXACTLY ONE active session exists
    if (uniqueSessions.length === 0) {
      console.log('⚠️ Recovery: Orders found but no session_id - cannot restore')
      return null
    }

    if (uniqueSessions.length > 1) {
      console.log('⚠️ Recovery: Multiple active sessions detected - DO NOT restore (prevents leakage)')
      console.log('⚠️ Recovery: Sessions:', uniqueSessions)
      return null
    }

    // Exactly one session - safe to restore
    const sessionIdToRestore = uniqueSessions[0]
    console.log('🔁 Restored session from active table order:', sessionIdToRestore)
    console.log('🔁 Recovery: This session has', sessionGroups.get(sessionIdToRestore), 'active order(s)')

    // Save to localStorage
    localStorage.setItem(SESSION_KEY, sessionIdToRestore)
    
    return sessionIdToRestore
  } catch (error: any) {
    console.error('❌ Recovery: Error during session recovery:', error)
    return null
  }
}

