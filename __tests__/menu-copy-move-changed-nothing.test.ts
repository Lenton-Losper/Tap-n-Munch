import { MENU_COPY, MENU_COPY_NOT_PROSE } from '@/lib/customer-copy/menu-copy'

/**
 * #334 STEP 2 — PROVE THE MOVE CHANGED NOTHING.
 *
 * Moving 100+ customer strings out of screens and into a copy module is the kind of refactor where
 * a stray edit is invisible: nothing type-checks differently, nothing fails, and a customer reads
 * slightly different words forever. The ruling was explicit that moving is not rewriting.
 *
 * So every string below is pinned to the EXACT literal it replaced, transcribed from the screen
 * before the move. This suite is not testing that the copy is good — it is testing that it is
 * UNCHANGED. If a value here needs to change, that is a copy decision and it comes with a sign-off,
 * at which point this file is updated deliberately rather than drifting.
 *
 * Written character-by-character on purpose, including the em dashes and the ellipsis, because those
 * are exactly what a well-meaning editor "fixes".
 */
describe('every moved string is byte-identical to the literal it replaced', () => {
  const ORIGINALS: Record<string, string> = {
    // ---- app/menu/[restaurantId]/receipt/page.tsx
    receiptNoActiveOrders: 'No active orders found.',
    receiptUnknownItem: 'Unknown Item',
    // ---- app/menu/[restaurantId]/cart/page.tsx
    // SIGNED REPLACEMENTS, not moves. Pinned to the wording the owner signed 2026-08-24, so a
    // later edit still has to be deliberate.
    cartSessionEndedTitle: 'session ended',
    cartSessionEndedBody: 'scan the QR code at your table to start again.',
    // SIGNED 2026-08-24 — payment copy keyed by service model, replacing the isKiosk switch.
    payCounterCashLabel: 'pay with cash',
    payCounterCashBody: 'pay at the counter when you collect your order',
    payCounterCardLabel: 'pay by card',
    payCounterCardBody: 'tap your card at the counter when you collect your order',
    payTableCashLabel: 'pay with cash',
    payTableCashBody: 'someone will come to your table to take payment',
    payTableCardLabel: 'pay by card',
    payTableCardBody: 'someone will bring a card machine to your table',
    tabClosedTitle: 'tab closed',
    tabClosedTableBody: 'someone is on their way. you cannot add more items.',
    tabClosedCounterBody: 'pay at the counter when you are ready. you cannot add more items.',
    tabCloseFailedTitle: 'could not close your tab',
    tabCloseFailedBody: 'your tab is still open. please ask a member of staff.',
  }

  it.each(Object.entries(ORIGINALS))('%s is unchanged', (key, original) => {
    expect(MENU_COPY[key as keyof typeof MENU_COPY]).toBe(original)
  })

  it('the pinned list covers every key in MENU_COPY', () => {
    // Without this, a key added without a pin is silently unprotected — which is the same
    // opt-in-enforcement hole that let a bare literal escape sign-off in the first place.
    expect(Object.keys(MENU_COPY).sort()).toEqual(Object.keys(ORIGINALS).sort())
  })
})

describe('the not-prose allowlist stays small and honest', () => {
  it('holds only internal throw messages, never anything a customer reads', () => {
    // These are `throw new Error(...)` fallbacks. customerSafeError maps anything reaching a
    // customer to allowlisted wording, so the thrown text is never rendered.
    expect(MENU_COPY_NOT_PROSE).toEqual([
      'Failed to add to tab',
      'Failed to place order',
      'No order ID returned',
    ])
  })

  it('has no duplicates, so a stale entry cannot hide behind a live one', () => {
    expect(new Set(MENU_COPY_NOT_PROSE).size).toBe(MENU_COPY_NOT_PROSE.length)
  })
})

describe('the service-model split is real, not decorative', () => {
  it('counter copy never promises a person', () => {
    // The whole reason this column exists: a counter-service venue may have no table staff at all.
    for (const k of ['payCounterCashBody', 'payCounterCardBody', 'tabClosedCounterBody'] as const) {
      expect(MENU_COPY[k]).not.toMatch(/someone|staff|waiter/i)
    }
  })

  it('table copy is the only place a person is promised', () => {
    expect(MENU_COPY.payTableCashBody).toMatch(/someone/)
    expect(MENU_COPY.payTableCardBody).toMatch(/someone/)
  })

  it('the two models say different things for the same payment method', () => {
    // If these ever collapse to the same sentence, the column has stopped doing anything.
    expect(MENU_COPY.payCounterCashBody).not.toBe(MENU_COPY.payTableCashBody)
    expect(MENU_COPY.payCounterCardBody).not.toBe(MENU_COPY.payTableCardBody)
    expect(MENU_COPY.tabClosedCounterBody).not.toBe(MENU_COPY.tabClosedTableBody)
  })

  it('the failure body says the tab is still open', () => {
    // After a failure the customer's real question is whether they still owe or can still order.
    expect(MENU_COPY.tabCloseFailedBody).toMatch(/still open/)
  })
})
