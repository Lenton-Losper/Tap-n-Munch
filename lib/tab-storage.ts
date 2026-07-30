/** Client-side persistence for the active table tab. */
export const TAB_ID_STORAGE_KEY = 'flashtap_tab_id'
export const TAB_TABLE_STORAGE_KEY = 'flashtap_table'
export const TAB_SESSION_ENDED_NOTICE_KEY = 'flashtap_session_ended_notice'
export const SESSION_TOKEN_STORAGE_KEY = 'flashtap_session_token'

export const TAB_SESSION_ENDED_MESSAGE =
  'Your session has ended. Scan the QR code to start a new order.'

/** Keys owned by contexts/tab-context.tsx; mirrored here so non-context callers can read them. */
export const TAB_SESSION_ID_KEY = 'tab_session_id'
export const LEGACY_TAB_SESSION_ID_KEY = 'flashtap_tab_session_id'

/**
 * The session id orders are actually submitted with, read without minting one.
 *
 * Distinct from lib/session.ts's flashtap_session_v1: different storage, different format,
 * and nothing syncs the two. Anything looking up a customer's own orders needs both, or it
 * silently finds nothing.
 */
export function readTabSessionId(): string | null {
  if (typeof window === 'undefined') return null
  const current = sessionStorage.getItem(TAB_SESSION_ID_KEY)?.trim()
  if (current) return current
  const legacy = sessionStorage.getItem(LEGACY_TAB_SESSION_ID_KEY)?.trim()
  return legacy || null
}

export function readStoredTabId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TAB_ID_STORAGE_KEY)?.trim() || null
}

export function readStoredTableNumber(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TAB_TABLE_STORAGE_KEY)?.trim() || null
}

export function persistTabSession(tabId: string, tableNumber: string | number) {
  if (typeof window === 'undefined') return
  localStorage.setItem(TAB_ID_STORAGE_KEY, tabId)
  localStorage.setItem(TAB_TABLE_STORAGE_KEY, String(tableNumber))
}

export function clearTabSession() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(TAB_ID_STORAGE_KEY)
  localStorage.removeItem(TAB_TABLE_STORAGE_KEY)
  sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
}

export function setSessionEndedNotice() {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(TAB_SESSION_ENDED_NOTICE_KEY, '1')
}

export function consumeSessionEndedNotice(): boolean {
  if (typeof window === 'undefined') return false
  const value = sessionStorage.getItem(TAB_SESSION_ENDED_NOTICE_KEY)
  if (!value) return false
  sessionStorage.removeItem(TAB_SESSION_ENDED_NOTICE_KEY)
  return true
}

/** Clears sessionStorage keys used by ActiveOrderBanner after table/tab close. */
export function clearActiveOrderBannerState() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem('last_order_id')
  sessionStorage.removeItem('flashtap_return_order_id')
  sessionStorage.removeItem('flashtap_return_table')
}
