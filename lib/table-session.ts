// @ts-nocheck
/**
 * Table Session Management
 * 
 * Table sessions are the source of truth for orders.
 * Each QR scan creates or resumes a table session.
 * Only ONE active session per table.
 */

import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'

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

  console.log('🔍 Checking for existing table session:', { restaurantId, tableNumber })

  const table = await getSupabaseTableByNumber(restaurantId, tableNumber, true)
  if (!table) {
    throw new Error(`Table ${tableNumber} not found for restaurant ${restaurantId}`)
  }
  const supabase = createServerSupabaseClient()
  const existingSession = String((table as any).session_id || '').trim()
  if (existingSession) {
    const sessionId = existingSession

    console.log('✅ Resuming existing table session:', sessionId)
    
    // Save to localStorage
    localStorage.setItem('table_session_id', sessionId)
    localStorage.setItem('table_session_restaurant', restaurantId)
    localStorage.setItem('table_session_table', String(tableNumber))

    return sessionId
  }

  // No active session found - create new one and bind to table
  console.log('🆕 Creating new table session for table', tableNumber)
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const { error } = await supabase
    .from('restaurant_tables')
    .update({
      session_id: sessionId,
      status: 'occupied',
      updated_at: new Date().toISOString(),
    })
    .eq('id', table.id)
  if (error) throw error

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
  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('restaurant_tables')
      .select('session_id,status')
      .eq('id', tableId)
      .eq('firebase_restaurant_id', restaurantId)
      .single()
    if (error || !data) {
      clearTableSession()
      return false
    }
    if (String((data as any).session_id || '') !== sessionId) {
      clearTableSession()
      return false
    }
    return String((data as any).status || '').toLowerCase() !== 'closed'
  } catch (error) {
    console.error('Error validating table session:', error)
    return false
  }
}

