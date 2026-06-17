/**
 * PART 1: Table-Based Session Recovery
 * 
 * Safely restores session from active table orders when customer rescans QR.
 * Prevents order leakage between customers.
 */

import { createServerSupabaseClient } from '@/lib/supabase/server'

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
  const existingTable = localStorage.getItem('flashtap_session_table_v1')
  const existingRestaurant = localStorage.getItem('flashtap_session_restaurant_v1')

  if (existingSession) {
    // If the existing session is tied to the same table/restaurant, keep it.
    // Otherwise clear and allow recovery/new session to be created.
    if (existingTable === String(tableNumber) && existingRestaurant === restaurantId) {
      console.log('✅ Session already exists, skipping recovery:', existingSession)
      return existingSession
    }

    console.log('🔁 Existing session/table mismatch; clearing before recovery', {
      existingSession,
      existingRestaurant,
      existingTable,
      requestedRestaurant: restaurantId,
      requestedTable: tableNumber,
    })
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem('flashtap_session_table_v1')
    localStorage.removeItem('flashtap_session_restaurant_v1')
  }

  try {
    console.log('🔍 PART 1: Running session recovery check for table', tableNumber)

    const supabase = createServerSupabaseClient()
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('table_number', tableNumber)
      .eq('table_closed', false)
      .in('status', ['pending', 'accepted', 'ready'])
    if (error) throw error

    console.log('📦 Recovery: Found', (orders || []).length, 'active orders for table', tableNumber)

    if (!orders || orders.length === 0) {
      console.log('📭 Recovery: No active orders found - table is clear, no session to restore')
      return null
    }

    // Group orders by session_id
    const sessionGroups = new Map<string, number>()
    orders.forEach((order: any) => {
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

