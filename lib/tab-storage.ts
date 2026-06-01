/** Client-side persistence for the active table tab. */
export const TAB_ID_STORAGE_KEY = 'flashtap_tab_id'
export const TAB_TABLE_STORAGE_KEY = 'flashtap_table'

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
}
