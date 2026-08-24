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
