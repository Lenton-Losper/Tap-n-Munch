import { getCurrentSession } from '@/lib/session'

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
  if (legacy) return legacy
  // The localStorage mirror. See TAB_SESSION_ID_MIRROR_KEY below for why it exists; reading it
  // here is what makes an order placed in a browser tab that has since closed findable again.
  const mirrored = localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)?.trim()
  if (mirrored) {
    // Rehydrate, so everything downstream that reads sessionStorage directly agrees with this.
    sessionStorage.setItem(TAB_SESSION_ID_KEY, mirrored)
    return mirrored
  }
  return null
}

/**
 * localStorage mirror of `tab_session_id`.
 *
 * THE BUG THIS FIXES. `tab_session_id` is the id a QR order is actually submitted with — it ends
 * up in `orders.session_id` / `order_requests.session_id` — and it was minted into
 * **sessionStorage only**. sessionStorage is per browser TAB and is destroyed when that tab
 * closes. So: place an order, close the tab (or open My Orders in a new one), and
 * `ensureTabSessionId` mints a brand-new id, the by-session lookup matches nothing, and My Orders
 * shows "No orders yet" — permanently — while the order sits in the database.
 *
 * Reproduced on staging 2026-08-13: request `waiting_review`, N$381, one item,
 * `session_id = session_1786615850151_8kbbfwp6jne`, returned correctly by
 * `GET /api/guest/orders/by-session` for that id and invisible to a browser that no longer had
 * it. The server was never wrong.
 *
 * Mirroring rather than moving: sessionStorage stays the primary so nothing that reads the key
 * directly changes behaviour, and no existing session is invalidated. `flashtap_tab_id` and
 * `flashtap_table` were already in localStorage, so the tab itself survived while the member
 * identity holding its orders did not — an inconsistency, not a design. No comment, commit or
 * test anywhere recorded a reason for the split.
 *
 * Consequence worth stating: two browser tabs on one device now share one member identity rather
 * than becoming two members of the same tab. That is the more defensible reading of "one diner",
 * and it is what lib/session.ts already does with `flashtap_session_v1` in localStorage.
 */
export const TAB_SESSION_ID_MIRROR_KEY = 'flashtap_tab_session_id_mirror'

/**
 * Mint-or-read, in ONE place. contexts/tab-context.tsx had its own copy of the keys, the legacy
 * migration and the id format; two copies of "which id is this customer" is how the two halves
 * come to disagree about who placed an order.
 */
export function ensureTabSessionId(): string {
  if (typeof window === 'undefined') return ''
  const existing = readTabSessionId()
  if (existing) {
    // Backfill the mirror for every session that predates it, so already-placed orders become
    // findable again rather than only new ones.
    localStorage.setItem(TAB_SESSION_ID_MIRROR_KEY, existing)
    sessionStorage.setItem(TAB_SESSION_ID_KEY, existing)
    sessionStorage.removeItem(LEGACY_TAB_SESSION_ID_KEY)
    return existing
  }
  const generated = mintTabSessionId()
  sessionStorage.setItem(TAB_SESSION_ID_KEY, generated)
  localStorage.setItem(TAB_SESSION_ID_MIRROR_KEY, generated)
  return generated
}

/**
 * A NEW tab session id, from a CSPRNG.
 *
 * WHY THIS IS SECURITY, not tidiness. `ownsOrder` makes knowing a session id the WHOLE
 * authorisation for reading and editing an order — there is no second factor. This id was minted
 * as `session_${Date.now()}_${Math.random().toString(36).slice(2)}`:
 *
 *   - `Date.now()` is not a secret. An attacker who knows roughly when an order was placed knows
 *     it to within a narrow window, and the value is printed in the id itself.
 *   - `Math.random()` is not a CSPRNG. V8's implementation is xorshift128+, seeded per context and
 *     recoverable from a small number of outputs; `.toString(36).slice(2)` then keeps only ~11
 *     base-36 characters of it.
 *
 * `lib/session.ts` already uses `crypto.randomUUID()` for its own id. This one — **the id most
 * orders actually carry**, because the cart submits it as both `session_id` and
 * `member_session_id` — did not. Same finding as #122's CSPRNG work on payment references, in a
 * different place and on a value that is now an authorisation token.
 *
 * The `session_` prefix is kept deliberately: it is how these ids are recognisable in logs, in
 * `tabs.members[]`, and against the `sess_` format lib/session.ts mints, and changing the shape
 * would be a second, unnecessary variable in the same change.
 *
 * NEW MINTS ONLY. Existing ids keep working untouched — `ensureTabSessionId` returns any stored
 * value before ever reaching here, `readTabSessionId` reads all three legacy locations, and no
 * row is rewritten. A customer mid-meal is unaffected; the weak ids age out as sessions end.
 */
export function mintTabSessionId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') {
    return `session_${c.randomUUID()}`
  }
  // randomUUID needs a SECURE CONTEXT and Safari 15.4+, and is absent under jsdom. getRandomValues
  // is a CSPRNG with much wider reach, so it is the fallback rather than a weaker generator.
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `session_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // NEVER Math.random. This id IS the authorisation (see ownsOrder), so a silent downgrade to a
  // guessable generator would reintroduce the exact defect this function was written to close —
  // and it would do it invisibly, on whichever browsers lack Web Crypto. Failing loudly means a
  // customer sees an error instead of being handed a forgeable identity.
  throw new Error('Cannot mint a tab session id: no Web Crypto available')
}

/**
 * EVERY session id this browser holds, for asking "is this my order?".
 *
 * The one place the list is assembled. Both ids matter and neither is reliably the right one:
 * `lib/session.ts` owns `flashtap_session_v1` (`sess_<uuid>`), this module owns `tab_session_id`
 * (`session_<ts>_<rand>`), nothing syncs them, and an order carries whichever the placing screen
 * held — the cart submits the tab-context one as both `session_id` and `member_session_id`.
 *
 * Three bugs on 2026-08-13 came from a caller picking one: guest queries filtered a single column,
 * My Orders rendered an empty list, and the edit route answered `404 Order not found` to the
 * customer's own order. Pass the result of this into `ownsOrder` (or a `sessionIds` parameter) and
 * the question cannot be got wrong again by omission.
 *
 * READ-ONLY: it never mints. A caller asking who it is must not create an identity as a side
 * effect — my-orders feeds this straight into a lookup, and minting there would guarantee a miss.
 *
 * Deliberately does NOT include the id off the order row being examined. Echoing a row's own id
 * back makes ownership pass unconditionally, and guestCanAccessOrder releases an OPEN order on
 * table_number alone — so that shortcut would let one diner at a table act on another's order.
 */
export function heldSessionIds(): string[] {
  if (typeof window === 'undefined') return []
  // getCurrentSession, not the raw localStorage key: lib/session.ts owns `flashtap_session_v1`
  // and reading it directly here would be a second copy of that ownership. It imports nothing,
  // so there is no cycle, and getCurrentSession is already a read that never mints.
  const ids: Array<string | null> = [getCurrentSession(), readTabSessionId()]
  return [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
}

export function clearTabSessionId(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(TAB_SESSION_ID_KEY)
  sessionStorage.removeItem(LEGACY_TAB_SESSION_ID_KEY)
  localStorage.removeItem(TAB_SESSION_ID_MIRROR_KEY)
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
