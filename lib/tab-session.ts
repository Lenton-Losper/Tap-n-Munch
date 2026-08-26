import { supabase } from '@/lib/supabase/client'
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/client'
import { clearTabSession, readStoredTabId, readStoredTableNumber, readTabSessionId } from '@/lib/tab-storage'
import {
  ACTIVE_TAB_STATUSES,
  isActiveTabStatus,
  isTabSessionEndedStatus,
} from '@/lib/tab-status'
// Type only -- erased at compile time. lib/tab-member-key.ts reads the service-role secret and
// must never be pulled into a client bundle as a value import.
import type { PublicTabMember } from '@/lib/tab-member-key'

// Defined in lib/tab-status.ts (no imports, so server code can use it) and re-exported here
// so the existing `from '@/lib/tab-session'` import sites are unchanged.
// Re-exported so every existing import site keeps working. The definitions live in
// lib/tab-status.ts because server code cannot import this module (browser client at import time).
export { ACTIVE_TAB_STATUSES, isActiveTabStatus, isTabSessionEndedStatus }

export type TabRow = {
  id: string
  restaurant_id?: string
  table_id?: string | null
  table_number?: number | null
  status?: string | null
  settled_type?: string | null
  /**
   * THE CACHE. Display-only, and knowingly wrong on some rows: five writers, two incompatible
   * definitions, seven money-changing events that skip it (lib/tabs/tab-outstanding.ts). No
   * customer surface may render this. Kept because staff-facing callers still read it.
   */
  total?: number | null
  /**
   * THE TWO AUTHORITATIVE FIGURES, computed server-side on the read that returns them.
   * `null` means the server could not sum it; render nothing rather than zero.
   *
   * payable — accepted and unpaid. What settlement charges. The ONLY figure a decision may use.
   * pending — submitted, not yet answered by the restaurant. Display only.
   */
  payable_total?: number | null
  pending_total?: number | null
  /**
   * #262: NEVER a `session_id`. The server substitutes an opaque per-tab `member_key`
   * (lib/tab-member-key.ts) before this ever reaches a client. Typed as the redacted shape so a
   * consumer that reaches for `session_id` fails to compile rather than silently rendering
   * "Guest" -- or, worse, sending someone else's credential somewhere.
   */
  members?: PublicTabMember[]
  payment_preference?: string | null
  ready_to_pay_at?: string | null
  pin_required?: boolean | null
}

/** Tab no longer accepts orders (staff closed table or settlement finished). */

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

/**
 * #262: no longer an anon PostgREST select.
 *
 * This was the last client read that named `members`, and its consumer genuinely needs the
 * array: app/menu/[restaurantId]/receipt/page.tsx buildMemberNameMap pairs a member with that
 * member's orders to print a name on each line. Simply dropping the column was rejected -- the
 * page falls into its `members.length === 0` branch and labels everybody "Guest".
 *
 * So it goes through GET /api/tabs/[tabId]/view, which runs the same lookup as service_role and
 * substitutes an opaque per-tab `member_key` for each `session_id`. The same key is stamped onto
 * `orders.member_session_id` by lib/guest-orders/queries.ts, so the pairing still resolves while
 * the credential never leaves the server. The filters are identical to the ones this function
 * applied (id + restaurant_id, matched raw), so a caller that used to get null still gets null.
 *
 * `readTabSessionId()` rides along so the route can tell the caller which member row is theirs;
 * it is the caller's OWN id and the guest order APIs already take it as a query parameter.
 */
export async function fetchTabById(tabId: string, restaurantId: string): Promise<TabRow | null> {
  const qs = new URLSearchParams({ restaurantId })
  const ownSessionId = String(readTabSessionId() || '').trim()
  if (ownSessionId) qs.append('sessionId', ownSessionId)

  const res = await fetch(
    `/api/tabs/${encodeURIComponent(tabId)}/view?${qs.toString()}`,
    { cache: 'no-store' },
  )
  const body = (await res.json().catch(() => ({}))) as {
    tab?: TabRow | null
    self_member_keys?: string[]
    error?: string
  }

  if (!res.ok) {
    const error = new Error(body?.error || `Tab lookup failed (${res.status})`)
    console.error('[TAB SESSION] fetchTabById error', error)
    throw error
  }

  return (body?.tab as TabRow) || null
}

/**
 * fetchActiveTabForTable REMOVED 2026-08-25 (#284).
 *
 * It had NO production callers -- only tests naming it -- and it was one of the last two reads of
 * `tabs` through the BROWSER ANON CLIENT. Leaving dead code that depends on a grant being revoked
 * is a landmine: it works in review and fails the first time anyone resurrects it.
 *
 * The live replacement is GET /api/tabs/active, which resolves the table row server-side and
 * returns a summary rather than the row. app/menu/[restaurantId]/v2/page.tsx already uses it.
 */
export async function fetchOrdersForTab(
  tabId: string,
  restaurantId: string,
  sessionId?: string | null,
) {
  // Callers pass the lib/session.ts id, but orders are submitted with the tab-context id
  // (see readTabSessionId). Send both -- querying with only one silently returns nothing.
  const sids = [...new Set(
    [String(sessionId || '').trim(), String(readTabSessionId() || '').trim()].filter(Boolean),
  )]
  // Guest by-session API requires session scope (tab UUID alone is insufficient).
  if (sids.length === 0) return []

  const { orders } = await fetchGuestOrdersBySession({
    restaurantId,
    sessionId: sids[0],
    sessionIds: sids,
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
