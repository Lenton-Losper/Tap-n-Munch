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
 *
 * REVISED 2026-08-28 for the real four-state model (lib/orders/order-lines.ts). Retired rather
 * than repurposed, because their OLD meaning is no longer true of the zone they labelled:
 *  - kitchen.readyToRunHeading / readyToRunEmpty described a zone of lines already passed. That
 *    zone cannot exist on this screen any more — GET /api/station/lines excludes 'ready' lines
 *    from a station's own board server-side (see lib/stations/types.ts's docblock) — so keeping
 *    the string would describe a section that no longer renders anything real.
 *  - bar.outHeading / outEmpty described a persisted archive of already-bumped rounds, which the
 *    same filter makes impossible to populate truthfully from this route. See bar-screen.tsx.
 * Replaced by kitchen.cookedHeading / cookedEmpty below, naming what the escalating zone now
 * actually shows: a plated dish still waiting on the pass, not one already sent. kitchen.
 * readyToRunButton and bar.outButton are UNCHANGED — both taps still do exactly what those
 * labels say, only the zone that surrounded the button changed.
 */

export const STATION_COPY = {
  kitchen: {
    pageTitle: 'Kitchen',
    /** The escalating zone: cooked, not yet passed. Not "ready to run" — see the file docblock
     *  on why that zone can no longer exist on this screen. */
    cookedHeading: 'Cooked — awaiting pass',
    outstandingHeading: 'Outstanding',
    cookedEmpty: 'Nothing cooked yet.',
    outstandingEmpty: 'Nothing waiting.',
    /** Station tap: this line is cooked, awaiting the pass. */
    cookedButton: 'Cooked',
    /** Pass tap: this line is confirmed and can leave the kitchen. Removes it from this board. */
    readyToRunButton: 'Ready to run',
    /**
     * UNSIGNED. The per-table shortcut, on the card header, beside the table number. One tap for a
     * table whose whole ticket landed at once — it must not cost five taps — while every line keeps
     * its own button, because a salad and a steak do not finish together.
     *
     * Whoever writes this: it acts on EVERY OUTSTANDING LINE THIS CARD IS SHOWING and nothing else.
     * It is not "the whole order" and it is not "the whole table" — the bar's half of the same
     * order is untouched, and so is anything already cooked.
     */
    allCookedButton: 'PENDING COPY: the button that marks every outstanding line on one table card cooked, in one tap',
    /**
     * UNSIGNED. Same shortcut on the pass side of the board: every line this card is showing as
     * cooked-and-waiting goes ready to run at once.
     */
    allReadyToRunButton: 'PENDING COPY: the button that marks every cooked line on one table card ready to run, in one tap',
    /**
     * "Table 0" was on the wall. Zero is not a table in any restaurant — it was a default from a
     * writer with no table to record, and a cook reading it has nothing to act on.
     *
     * An absent table now says so in words. NOT a dash: at 3m a dash reads as a rendering fault,
     * and a cook's next move is to ask whether the screen is broken. "No table" is a fact about
     * the order, and the card still carries the item so the food can be made while somebody works
     * out where it goes.
     */
    tableLabel: (tableNumber: string) =>
      tableNumber.trim() === '' ? 'No table' : `Table ${tableNumber}`,
  },
  bar: {
    pageTitle: 'Bar',
    inHeading: 'In',
    inEmpty: 'Nothing in.',
    /** The one tap that sends a whole round straight to ready. Removes it from this board — see
     *  bar-screen.tsx on why there is no persisted Out column any more. NOW PER LINE: a round is
     *  not poured all at once either, and the label is still exactly what the tap does. */
    outButton: 'Out',
    /**
     * UNSIGNED. The per-round shortcut, matching the kitchen's per-table one: every line this round
     * card is showing goes out in one tap. The bar's half only — a kitchen line on the same order
     * is untouched.
     */
    allOutButton: 'PENDING COPY: the button that sends every line in one bar round out, in one tap',
    /** Same absent-table rule as the kitchen — see the note there. */
    tableLabel: (tableNumber: string) =>
      tableNumber.trim() === '' ? 'No table' : `Table ${tableNumber}`,
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
  /**
   * WHAT A CARD SAYS WHEN A MULTI-LINE BUMP ONLY PARTLY LANDED.
   *
   * The failure this exists for: one tap on "all cooked" for a table of five, three lines move and
   * two are refused (another screen got there first, the terminal voided one mid-service). The
   * three that moved leave the board on the next refetch. Without this, the card silently shrinks
   * from five rows to two and reads exactly like a table where two dishes are still being made —
   * so nobody ever finds out that two lines were refused.
   *
   * Deliberately NOT a toast. A toast on a wall screen nobody stands in front of is the same as no
   * message: it appears and expires while the kitchen is looking at the grill. These sit ON the
   * card, and stay until the lines they name leave it.
   *
   * The counts are rendered as their own element next to `heading`, not interpolated into it, so
   * that scripts/check-no-pending-copy.mjs — a SOURCE scanner — can still see these markers. A
   * marker it cannot see is worse than no marker.
   */
  bumpFailure: {
    /** UNSIGNED. Card-level: some of what you just tapped did not move. Shown with "N/M" beside it. */
    heading: 'PENDING COPY: told on a table card when only some of the lines it just bumped actually moved',
    /** UNSIGNED. Row-level, on each individual line that was refused, so it is findable at 3m. */
    lineMarker: 'PENDING COPY: the marker on the one line that would not move, sat on the line itself',
    /** UNSIGNED. The button's own label while its bump is in flight and it is not tappable. */
    working: 'PENDING COPY: what a bump button says while it is in flight and cannot be tapped again',
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
