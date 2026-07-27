import { supabase } from '@/lib/supabase/client'
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/client'
import { clearTabSession, readStoredTabId, readStoredTableNumber } from '@/lib/tab-storage'

export const ACTIVE_TAB_STATUSES = ['open', 'ready_to_pay'] as const

export type TabRow = {
  id: string
  restaurant_id?: string
  table_id?: string | null
  table_number?: number | null
  status?: string | null
  settled_type?: string | null
  total?: number | null
  members?: unknown
  payment_preference?: string | null
  ready_to_pay_at?: string | null
  pin_required?: boolean | null
}

export function isActiveTabStatus(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return ACTIVE_TAB_STATUSES.includes(s as (typeof ACTIVE_TAB_STATUSES)[number])
}

/** Tab no longer accepts orders (staff closed table or settlement finished). */
export function isTabSessionEndedStatus(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'settled' || s === 'closed' || s === 'completed' || s === 'cancelled'
}

export function shouldShowTabPaymentThanks(tab: TabRow | null | undefined): boolean {
  if (!tab) return false
  return (
    String(tab.status || '').toLowerCase() === 'settled' &&
    String(tab.settled_type || '').toLowerCase() === 'card_payment'
  )
}

/** Clear localStorage and leave tab flow (not for card-payment thank-you screen). */
export function shouldClearTabAfterSettlement(tab: TabRow | null | undefined): boolean {
  if (!tab) return true
  if (shouldShowTabPaymentThanks(tab)) return false
  const status = String(tab.status || '').toLowerCase()
  if (isActiveTabStatus(status)) return false
  if (status === 'settled' || status === 'closed') return true
  return true
}

export function shouldRedirectFromTabReceipt(tab: TabRow | null | undefined): boolean {
  if (!tab) return true
  if (shouldShowTabPaymentThanks(tab)) return false
  return !isActiveTabStatus(tab.status)
}

/** Prefer localStorage tab id; optional URL tab id must match stored id when both present. */
export function resolveStoredTabId(urlTabId?: string | null): string | null {
  const stored = readStoredTabId()
  const fromUrl = urlTabId?.trim() || ''
  if (stored && fromUrl && stored !== fromUrl) {
    console.warn('[TAB SESSION] URL tabId does not match localStorage; using stored', {
      stored,
      fromUrl,
    })
  }
  return stored || fromUrl || null
}

export async function fetchTabById(tabId: string, restaurantId: string): Promise<TabRow | null> {
  const { data, error } = await supabase
    .from('tabs')
    .select('id, restaurant_id, table_id, table_number, status, settled_type, total, members, payment_preference, ready_to_pay_at, pin_required')
    .eq('id', tabId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) {
    console.error('[TAB SESSION] fetchTabById error', error)
    throw error
  }
  if (!data) return null
  return data as TabRow
}

export async function fetchActiveTabForTable(
  restaurantId: string,
  tableId: string | null,
  tableNumber: number
): Promise<TabRow | null> {
  let query = supabase
    .from('tabs')
    .select('id, restaurant_id, table_id, table_number, status, settled_type, total, members, payment_preference, ready_to_pay_at, pin_required')
    .eq('restaurant_id', restaurantId)
    .in('status', [...ACTIVE_TAB_STATUSES])

  if (tableId) {
    query = query.eq('table_id', tableId)
  } else if (tableNumber > 0) {
    query = query.eq('table_number', tableNumber)
  } else {
    return null
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) {
    console.error('[TAB SESSION] fetchActiveTabForTable error', error)
    throw error
  }
  return (data as TabRow) || null
}

export async function fetchOrdersForTab(
  tabId: string,
  restaurantId: string,
  sessionId?: string | null,
) {
  const sid = String(sessionId || '').trim()
  // Guest by-session API requires session_id (tab UUID alone is insufficient).
  if (!sid) return []

  const { orders } = await fetchGuestOrdersBySession({
    restaurantId,
    sessionId: sid,
    tabId,
    excludeSettlement: true,
  })
  return [...(orders || [])].sort((a, b) => {
    const aTime = String(a.placed_at || a.created_at || '')
    const bTime = String(b.placed_at || b.created_at || '')
    return aTime.localeCompare(bTime)
  })
}

export function landingPath(restaurantId: string, tableNumber: string | number): string {
  const t = String(tableNumber || '').trim()
  return `/menu/${restaurantId}/v2${t ? `?table=${encodeURIComponent(t)}` : ''}`
}

export function clearTabAndGetLandingPath(restaurantId: string, tableNumber?: string | number | null): string {
  clearTabSession()
  const table =
    tableNumber != null && String(tableNumber).trim() !== ''
      ? tableNumber
      : readStoredTableNumber() || ''
  return landingPath(restaurantId, table)
}
