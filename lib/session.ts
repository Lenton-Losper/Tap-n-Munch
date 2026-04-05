/**
 * Session Management - Unique per QR scan
 * 
 * Core Design Decision:
 * - session_id MUST be unique per QR scan session
 * - session MUST be tied to a specific table to prevent cross-table leakage
 */

const SESSION_KEY = 'flashtap_session_v1'
const SESSION_TABLE_KEY = 'flashtap_session_table_v1'
const SESSION_RESTAURANT_KEY = 'flashtap_session_restaurant_v1'

/**
 * Create a brand-new session ID (fresh QR scan).
 * 
 * This invalidates any previously stored cart tied to the old session.
 */
export function createFreshSession(restaurantId: string, tableId: string): string | null {
  if (typeof window === 'undefined') return null

  // Always generate new unique session ID
  const sessionId = `sess_${crypto.randomUUID()}`
  localStorage.setItem(SESSION_KEY, sessionId)
  localStorage.setItem(SESSION_TABLE_KEY, tableId)
  localStorage.setItem(SESSION_RESTAURANT_KEY, restaurantId)
  sessionStorage.setItem(SESSION_KEY, sessionId)
  console.log('🆕 Created fresh session:', sessionId, 'for restaurant:', restaurantId, 'table:', tableId)
  return sessionId
}

/**
 * Get or create a session ID that matches the requested table.
 * If the stored session is for a different table, a new session is created.
 */
export function getOrCreateSession(restaurantId: string, tableId: string): string | null {
  if (typeof window === 'undefined') return null

  const existing = localStorage.getItem(SESSION_KEY)
  const existingTable = localStorage.getItem(SESSION_TABLE_KEY)
  const existingRestaurant = localStorage.getItem(SESSION_RESTAURANT_KEY)

  if (existing && existingTable === tableId && existingRestaurant === restaurantId) {
    sessionStorage.setItem(SESSION_KEY, existing)
    console.log('✅ Restoring existing session:', existing, 'for table:', tableId)
    return existing
  }

  return createFreshSession(restaurantId, tableId)
}

/**
 * Get current session ID
 */
export function getCurrentSession(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(SESSION_KEY)
}

/**
 * Get session info (for debugging)
 */
export function getSessionInfo(): {
  sessionId: string | null
  restaurant: string | null
  table: string | null
} {
  if (typeof window === 'undefined') {
    return { sessionId: null, restaurant: null, table: null }
  }
  return {
    sessionId: localStorage.getItem(SESSION_KEY),
    restaurant: localStorage.getItem(SESSION_RESTAURANT_KEY),
    table: localStorage.getItem(SESSION_TABLE_KEY),
  }
}

/**
 * Clear session (only when explicitly requested)
 */
export function clearSession(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(SESSION_TABLE_KEY)
  localStorage.removeItem(SESSION_RESTAURANT_KEY)
  sessionStorage.removeItem(SESSION_KEY)
  console.log('🗑️ Session cleared')
}

/**
 * Check if session is valid
 */
export function isSessionValid(): boolean {
  if (typeof window === 'undefined') return false
  const sessionId = localStorage.getItem(SESSION_KEY)
  return sessionId !== null && sessionId.startsWith('sess_')
}
