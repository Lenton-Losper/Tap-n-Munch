/**
 * @jest-environment jsdom
 *
 * jsdom, because the whole defect lives in the difference between two browser storages and the
 * default `node` environment has neither. Same directive the render suites in this folder use.
 *
 * My Orders showed "No orders yet" while the order was sitting in the database.
 *
 * `tab_session_id` is the id a QR order is actually submitted with — it lands in
 * `orders.session_id` / `order_requests.session_id` — and it was minted into **sessionStorage
 * only**. sessionStorage is per browser TAB and dies with it. Place an order, then open My Orders
 * in a new tab: a fresh id is minted, the by-session lookup matches nothing, and the customer is
 * told they have never ordered.
 *
 * Reproduced on staging 2026-08-13 — request `waiting_review`, N$381,
 * `session_id = session_1786615850151_8kbbfwp6jne`, returned correctly by the deployed
 * `GET /api/guest/orders/by-session` for that id and invisible to a browser that no longer held
 * it. The server was never wrong, which is why no server test could have caught this.
 *
 * These bind to lib/tab-storage.ts itself. "Closing the tab" is modelled by clearing
 * sessionStorage and keeping localStorage, which is exactly what a browser does.
 */
import {
  TAB_SESSION_ID_KEY,
  TAB_SESSION_ID_MIRROR_KEY,
  LEGACY_TAB_SESSION_ID_KEY,
  clearTabSessionId,
  ensureTabSessionId,
  mintTabSessionId,
  readTabSessionId,
} from '@/lib/tab-storage'

/** What a browser does when the tab closes: sessionStorage goes, localStorage stays. */
function closeBrowserTab() {
  window.sessionStorage.clear()
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})

/**
 * The mint is a CSPRNG, because `ownsOrder` makes knowing this id the WHOLE authorisation for
 * reading and editing an order. It was `Date.now()` plus `Math.random().toString(36).slice(2)`:
 * a timestamp that is not a secret and ~11 base-36 characters of xorshift128+. lib/session.ts
 * already used crypto.randomUUID for its own id; this one — the id most orders actually carry —
 * did not.
 */
describe('the tab session id is unguessable', () => {
  it('is a UUID behind the session_ prefix', () => {
    const id = mintTabSessionId()
    expect(id).toMatch(
      /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('contains no timestamp — the old format published when the order was placed', () => {
    // `session_1786615850151_...` leaked its own mint time in the id. A caller who knows roughly
    // when an order was placed knew most of the search space.
    expect(mintTabSessionId()).not.toMatch(/^session_\d{10,}_/)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintTabSessionId()))
    expect(ids.size).toBe(200)
  })

  it('keeps the session_ prefix, so the format stays recognisable', () => {
    // Deliberate: it is how these ids are told apart from lib/session.ts's `sess_` ids in logs
    // and in tabs.members[]. Changing the shape would be a second variable in one change.
    expect(mintTabSessionId().startsWith('session_')).toBe(true)
  })

  it('accepts an OLD weak id that is already stored — new mints only', () => {
    // A customer mid-meal when this ships must not be logged out, and no row is rewritten.
    window.sessionStorage.setItem(TAB_SESSION_ID_KEY, 'session_1786615850151_8kbbfwp6jne')
    expect(ensureTabSessionId()).toBe('session_1786615850151_8kbbfwp6jne')
    expect(readTabSessionId()).toBe('session_1786615850151_8kbbfwp6jne')
  })
})

describe('the id a QR order is submitted with survives the browser tab closing', () => {
  it('mints into BOTH storages', () => {
    const minted = ensureTabSessionId()

    // The CSPRNG format. This assertion used to pin the WEAK one (`session_<ts>_<rand>`), which is
    // how a test holds a defect in place: it was green on precisely the id it should have rejected.
    expect(minted).toMatch(/^session_[0-9a-f-]{36}$/i)
    expect(window.sessionStorage.getItem(TAB_SESSION_ID_KEY)).toBe(minted)
    expect(window.localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)).toBe(minted)
  })

  it('reads the SAME id back after the tab closes — the whole bug', () => {
    const beforeClose = ensureTabSessionId()
    closeBrowserTab()

    // Before the fix this minted a brand-new id and every order placed under the old one became
    // permanently invisible to this browser.
    expect(readTabSessionId()).toBe(beforeClose)
    expect(ensureTabSessionId()).toBe(beforeClose)
  })

  it('rehydrates sessionStorage from the mirror, so direct readers agree', () => {
    const id = ensureTabSessionId()
    closeBrowserTab()
    expect(window.sessionStorage.getItem(TAB_SESSION_ID_KEY)).toBeNull()

    readTabSessionId()

    // contexts/tab-context and others read this key directly; leaving it unset would mean two
    // answers to "who is this customer" inside one page load.
    expect(window.sessionStorage.getItem(TAB_SESSION_ID_KEY)).toBe(id)
  })

  it('backfills the mirror for a session that predates the fix', () => {
    // A customer mid-meal when this ships: sessionStorage has an id, localStorage has nothing.
    // Their already-placed orders must become findable, not just their next ones.
    window.sessionStorage.setItem(TAB_SESSION_ID_KEY, 'session_1786615850151_8kbbfwp6jne')

    const id = ensureTabSessionId()

    expect(id).toBe('session_1786615850151_8kbbfwp6jne')
    expect(window.localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)).toBe(
      'session_1786615850151_8kbbfwp6jne',
    )
  })

  it('still honours the legacy key, and migrates it', () => {
    window.sessionStorage.setItem(LEGACY_TAB_SESSION_ID_KEY, 'session_legacy_1')

    const id = ensureTabSessionId()

    expect(id).toBe('session_legacy_1')
    expect(window.sessionStorage.getItem(TAB_SESSION_ID_KEY)).toBe('session_legacy_1')
    expect(window.sessionStorage.getItem(LEGACY_TAB_SESSION_ID_KEY)).toBeNull()
    expect(window.localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)).toBe('session_legacy_1')
  })

  it('does not invent an id on a read', () => {
    // readTabSessionId is used by callers that must not create identity as a side effect of
    // asking — my-orders passes it straight into a lookup.
    expect(readTabSessionId()).toBeNull()
    expect(window.localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)).toBeNull()
  })

  it('clears both storages when the session is ended deliberately', () => {
    ensureTabSessionId()

    clearTabSessionId()

    expect(readTabSessionId()).toBeNull()
    expect(window.localStorage.getItem(TAB_SESSION_ID_MIRROR_KEY)).toBeNull()
    // "Browser cleared means no link, and that is accepted" — an END SESSION must still end it.
    expect(ensureTabSessionId()).not.toBe('')
  })

  it('gives two browser tabs on one device the SAME member identity', () => {
    // The deliberate consequence of mirroring, stated so it is not discovered as a surprise:
    // one device is one diner, which is what lib/session.ts already assumes with
    // flashtap_session_v1 in localStorage.
    const firstTab = ensureTabSessionId()
    closeBrowserTab() // a second tab starts with its own empty sessionStorage
    const secondTab = ensureTabSessionId()

    expect(secondTab).toBe(firstTab)
  })
})
