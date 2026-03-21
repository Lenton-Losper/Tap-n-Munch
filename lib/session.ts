/**
 * Session Management - Unique per QR scan
 * 
 * Core Design Decision:
 * - session_id MUST be unique per scan, not per table
 * - Sessions reset only when browser storage is cleared
 * - Do NOT reuse sessions per table
 */

const SESSION_KEY = 'flashtap_session_v1'

/**
 * Get or create a unique session ID
 * 
 * Every QR scan generates or restores a unique session.
 * Sessions are NOT tied to tables - they're device/visit-specific.
 */
export function getOrCreateSession(restaurantId: string, tableId: string): string | null {
  if (typeof window === 'undefined') return null

  // Check for existing session
  const existing = localStorage.getItem(SESSION_KEY)
  if (existing) {
    console.log('✅ Restoring existing session:', existing)
    return existing
  }

  // Generate new unique session ID
  const sessionId = `sess_${crypto.randomUUID()}`
  localStorage.setItem(SESSION_KEY, sessionId)
  console.log('🆕 Created new session:', sessionId, 'for restaurant:', restaurantId, 'table:', tableId)
  return sessionId
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
  restaurant?: string
  table?: string
} {
  if (typeof window === 'undefined') {
    return { sessionId: null }
  }
  return {
    sessionId: localStorage.getItem(SESSION_KEY),
  }
}

/**
 * Clear session (only when explicitly requested)
 */
export function clearSession(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(SESSION_KEY)
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
