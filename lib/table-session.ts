/**
 * Table Session Management
 * 
 * Table sessions are the source of truth for orders.
 * Each QR scan creates or resumes a table session.
 * Only ONE active session per table.
 */

import { collection, query, where, limit, getDocs, addDoc, updateDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { tableSessionsPath, tableSessionPath } from '@/lib/firebase/paths'
import { getTableByNumber } from '@/lib/firebase/tables'

export interface TableSession {
  id: string
  restaurant_id: string
  table_number: number
  status: 'active' | 'closed'
  created_at: any
  closed_at?: any
}

/**
 * Get or create table session
 * 
 * Rules:
 * - Check Firestore for active session for this table/restaurant
 * - If found, save to localStorage and return
 * - If NOT found, create new session
 * - NEVER reuse a CLOSED session
 */
export async function getOrCreateTableSession(
  restaurantId: string,
  tableNumber: number
): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('getOrCreateTableSession must be called client-side')
  }

  if (!db) {
    throw new Error('Firestore not initialized')
  }

  console.log('🔍 Checking for existing table session:', { restaurantId, tableNumber })

  // NEW: First, get the table to find its ID (needed for hierarchical path)
  const table = await getTableByNumber(restaurantId, tableNumber)
  if (!table) {
    throw new Error(`Table ${tableNumber} not found for restaurant ${restaurantId}`)
  }
  const tableId = table.id

  // Check Firestore for active session
  // NEW: Use hierarchical path - restaurant_id and table_number are in the path
  const sessionsRef = collection(db, tableSessionsPath(restaurantId, tableId))
  const q = query(
    sessionsRef,
    where('status', '==', 'active'),
    limit(1)
  )

  const snapshot = await getDocs(q)

  if (!snapshot.empty) {
    // Found active session - resume it
    const sessionDoc = snapshot.docs[0]
    const sessionId = sessionDoc.id
    const sessionData = sessionDoc.data()

    console.log('✅ Resuming existing table session:', sessionId)
    
    // Save to localStorage
    localStorage.setItem('table_session_id', sessionId)
    localStorage.setItem('table_session_restaurant', restaurantId)
    localStorage.setItem('table_session_table', String(tableNumber))

    return sessionId
  }

  // No active session found - create new one
  console.log('🆕 Creating new table session for table', tableNumber)

  // NEW: Remove restaurant_id and table_number from document (they're in the path)
  const newSession = {
    // restaurant_id: restaurantId, // REMOVED - in path
    // table_number: tableNumber, // REMOVED - in path
    status: 'active' as const,
    created_at: serverTimestamp(),
  }

  const docRef = await addDoc(collection(db, tableSessionsPath(restaurantId, tableId)), newSession)
  const sessionId = docRef.id

  console.log('✅ Created new table session:', sessionId)

  // Save to localStorage
  localStorage.setItem('table_session_id', sessionId)
  localStorage.setItem('table_session_restaurant', restaurantId)
  localStorage.setItem('table_session_table', String(tableNumber))

  return sessionId
}

/**
 * Get current table session ID from localStorage
 */
export function getCurrentTableSession(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('table_session_id')
}

/**
 * Get table session info from localStorage
 */
export function getTableSessionInfo(): {
  sessionId: string | null
  restaurant: string | null
  table: string | null
} {
  if (typeof window === 'undefined') {
    return { sessionId: null, restaurant: null, table: null }
  }
  return {
    sessionId: localStorage.getItem('table_session_id'),
    restaurant: localStorage.getItem('table_session_restaurant'),
    table: localStorage.getItem('table_session_table'),
  }
}

/**
 * Clear table session from localStorage
 */
export function clearTableSession(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem('table_session_id')
  localStorage.removeItem('table_session_restaurant')
  localStorage.removeItem('table_session_table')
  console.log('Table session cleared from localStorage')
}

/**
 * Check if table session is active in Firestore
 * Safety guard: If localStorage has session but it's closed, clear it
 */
export async function validateTableSession(restaurantId: string, tableId: string, sessionId: string): Promise<boolean> {
  if (!db) return false

  try {
    // NEW: Use hierarchical path
    const sessionDoc = await getDoc(doc(db, tableSessionPath(restaurantId, tableId, sessionId)))
    
    if (!sessionDoc.exists()) {
      console.warn('⚠️ Table session not found in Firestore:', sessionId)
      clearTableSession()
      return false
    }

    const data = sessionDoc.data()
    if (data.status === 'closed') {
      console.warn('⚠️ Table session is CLOSED, clearing localStorage:', sessionId)
      clearTableSession()
      return false
    }

    return data.status === 'active'
  } catch (error) {
    console.error('Error validating table session:', error)
    return false
  }
}

