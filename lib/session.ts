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

  // Block session creation if a valid session token exists
  // This prevents createFreshSession from overriding an active or recently-expired session
  const existingToken = localStorage.getItem('flashtap_session_token') ||
                        sessionStorage.getItem('flashtap_session_token')

  if (existingToken) {
    console.log('[SESSION] blocked createFreshSession — session token exists, letting server validation run')
    return null
  }

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

/**
 * Begins a completely new kiosk customer lifecycle.
 * Clears all state from the previous customer (session, tab, cart,
 * return pointers) then creates a fresh session UUID.
 * Idempotent — safe to call multiple times.
 *
 * Principle: Identity is represented by session_id, not by display
 * data such as customer names. session_id is authoritative.
 */
export function startKioskCustomerSession(
  restaurantId: string,
  tableId: string
): string {
  if (typeof window === 'undefined') return ''

  // Clear previous customer's session
  localStorage.removeItem('flashtap_session_v1')
  localStorage.removeItem('flashtap_session_table_v1')
  localStorage.removeItem('flashtap_session_restaurant_v1')
  sessionStorage.removeItem('flashtap_session_v1')

  // Clear previous customer's tab state
  localStorage.removeItem('flashtap_tab_id')
  localStorage.removeItem('flashtap_table')
  localStorage.removeItem('flashtap_session_token')
  sessionStorage.removeItem('flashtap_session_token')
  sessionStorage.removeItem('tab_session_id')
  sessionStorage.removeItem('flashtap_tab_session_id')

  // Clear previous customer's cart
  localStorage.removeItem('cart')
  localStorage.removeItem('cart_session_id')

  // Clear previous customer's return pointers
  sessionStorage.removeItem('last_order_id')
  sessionStorage.removeItem('flashtap_return_order_id')
  sessionStorage.removeItem('flashtap_return_table')

  // Create fresh session for new customer
  const sessionId = `sess_${crypto.randomUUID()}`
  localStorage.setItem('flashtap_session_v1', sessionId)
  localStorage.setItem('flashtap_session_table_v1', tableId)
  localStorage.setItem('flashtap_session_restaurant_v1', restaurantId)
  sessionStorage.setItem('flashtap_session_v1', sessionId)

  console.log('[Kiosk] New customer session started:', sessionId)
  return sessionId
}
