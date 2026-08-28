/**
 * feat/station-screens-v1 — every user-facing string on the kitchen and bar screens.
 *
 * SIGNED 2026-08-28, following this repo's established convention (see
 * lib/dashboard/feed-connection-copy.ts, lib/recipes/quantity-sanity.ts's signed strings): one
 * module, greppable, so a copy review reads this file rather than hunting two component trees.
 *
 * Three corrections from the draft, on the record:
 *  - kitchen.outstandingEmpty: "no orders yet" reads as a system state; "Nothing waiting." is
 *    what a cook actually wants to know.
 *  - connection.offline / connection.reconnecting: rewritten to say what it MEANS for the
 *    reader, not what happened to the socket — a frozen list looks identical to a quiet
 *    kitchen, which is the exact failure #350 exists to prevent. Converged onto #350's own
 *    signed wording (lib/dashboard/feed-connection-copy.ts) rather than a fresh, near-identical
 *    phrasing living a second place.
 *  - connection.live was NOT part of the correction and stays as originally drafted.
 */

export const STATION_COPY = {
  kitchen: {
    pageTitle: 'Kitchen',
    readyToRunHeading: 'Ready to run',
    outstandingHeading: 'Outstanding',
    readyToRunEmpty: 'Nothing ready to run.',
    outstandingEmpty: 'Nothing waiting.',
    /** Station tap: this line is cooked, awaiting the pass. */
    cookedButton: 'Cooked',
    /** Pass tap: this line is confirmed and can leave the kitchen. */
    readyToRunButton: 'Ready to run',
    tableLabel: (tableNumber: string) => `Table ${tableNumber}`,
  },
  bar: {
    pageTitle: 'Bar',
    inHeading: 'In',
    outHeading: 'Out',
    inEmpty: 'Nothing in.',
    outEmpty: 'Nothing out yet.',
    /** The one tap that moves a whole round from IN to OUT. */
    outButton: 'Out',
    tableLabel: (tableNumber: string) => `Table ${tableNumber}`,
  },
  /** Shared by both screens — a route_to = 'unrouted' line must never read as ordinary work. */
  unrouted: {
    heading: 'Unrouted — no station assigned',
    /** Loud, not silent: this is the whole point of the section existing. */
    description: 'These lines have no kitchen or bar route. They will not appear anywhere else on this screen.',
    /**
     * PINNED, 2026-08-28: "it is the sentence that stops food going unseen and it is the kind
     * of thing that gets shortened out." Shown on EVERY unrouted row, not just the section
     * banner — the banner can be scrolled past; this cannot, because it sits on the item itself.
     */
    itemNote: 'This item has no station set. Check the menu.',
  },
  age: {
    justNow: 'just now',
    minutes: (n: number) => `${n} min`,
  },
  /**
   * The connection indicator's labels — same three-state shape and same rule
   * lib/dashboard/feed-connection-copy.ts documents (two facts, one imperative, only in
   * `offline`). `reconnecting` and `offline` are now the SAME wording as that already-signed
   * copy, on purpose (see the file docblock) — `live` was not part of that correction and keeps
   * its own drafted wording.
   */
  connection: {
    live: 'lines are arriving here as they happen',
    reconnecting: 'reconnecting - this list may be a moment behind',
    offline:
      'not receiving new orders. this list is refreshing slowly and orders may be missing. check the connection or reload.',
  },
  /** Shown instead of the board when stationScreensEnabled (20260828220000) is off. */
  notEnabled: {
    heading: 'Station screens are not turned on yet',
    description: 'Ask whoever manages this venue to enable kitchen and bar screens for it.',
  },
  /**
   * Shown instead of the board when this terminal is authenticated but not paired to THIS
   * screen (20260828230000_terminal_station_pairing.sql) -- a valid code for the other screen,
   * or a screen that was revoked. Distinct from notEnabled: the flag can be on venue-wide and
   * this one specific screen still be wrong.
   */
  notPaired: {
    heading: 'This screen is not paired',
    description: (pairedTo: string | null) =>
      pairedTo
        ? `This code is paired to the ${pairedTo} screen, not this one. Pair this screen from Settings.`
        : 'This code is not paired to a screen. Pair this screen from Settings.',
  },
  /** The on-page activation flow — reuses /api/terminals/activate, no new auth is built. */
  activation: {
    heading: 'Activate this screen',
    instructions: 'Enter the activation code from Settings → Terminals.',
    codePlaceholder: 'Activation code',
    submitButton: 'Activate',
    submittingButton: 'Activating…',
    invalidCode: 'Invalid or expired activation code.',
    genericError: 'Something went wrong. Try again.',
  },
} as const
