/**
 * REBUILT 20260829160000 for the high-density board — Ready is now a real, pinned zone on both
 * screens rather than a zone that could not exist. Signed directly, per the standing instruction
 * for this phase (draft copy in the house style, no PENDING COPY markers): say what happens, plain
 * words a cook or waiter actually uses, and when it touches money or food safety say the
 * consequence and what to do next.
 *
 * RETIRED, because their old meaning is no longer true of the zone they labelled:
 *  - kitchen.cookedHeading / cookedEmpty / outstandingHeading / outstandingEmpty described two
 *    SEPARATE zones. They are now one — kitchen.activeHeading / activeEmpty — because a table with
 *    one cooked dish and one unstarted one is one piece of active work, not two, and putting
 *    "finished, awaiting pass" above "not started" was the exact ordering the owner reported as
 *    backwards.
 *  - bar.inHeading / inEmpty described a single undifferentiated queue. Renamed to
 *    bar.activeHeading / activeEmpty ("To make") now that a round can have some drinks ready and
 *    some not — "in" no longer says which.
 * cookedButton and readyToRunButton (kitchen) and outButton (bar) are UNCHANGED: every one of
 * those taps still does exactly what its label says, only the zone around the button changed.
 *
 * ADDED:
 *  - kitchen.readyHeading / readyEmpty, bar.readyHeading / readyEmpty — the pinned zone.
 *  - kitchen.collectedButton / allCollectedButton, bar.collectedButton / allCollectedButton — the
 *    new action that clears a line off the pinned zone (order_line_events 'collected',
 *    20260829160000). Same word on both screens on purpose — "kitchen and bar share... same
 *    visual system" is this rebuild's own rule, and two boards that both clear a line the same way
 *    should say so with the same word.
 *  - unrouted.heading / description / itemNote — reworded around "NOT SENT", matching this
 *    rebuild's own brief verbatim ("food nobody is making — louder than anything else on the
 *    board"). Still says what to do next, per house style.
 *
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
 *
 * ADDED 2026-08-28 — `loading`. Measured directly against staging: the first fetch after
 * activation genuinely takes 1-3.4s (requireTerminalAuth, validateTerminalRecord, requireFeature
 * and assertTerminalPairedToStation are each their own DB round trip, sequential, before the
 * real board query even runs). Before that resolves, `lines`/`rounds` state is still its initial
 * `[]`, which rendered the SAME `cookedEmpty`/`outstandingEmpty`/`inEmpty` copy as a genuinely
 * empty board — indistinguishable from "nothing waiting" to whoever is standing in front of it.
 * Same failure shape #350 exists to prevent (a frozen list looks identical to a quiet kitchen),
 * one phase earlier: here it is the LOADING phase reading as empty, not the disconnected phase.
 */

export const STATION_COPY = {
  kitchen: {
    pageTitle: 'Kitchen',
    /** The active zone: everything not yet ready, whether it is still to cook or already plated
     *  and waiting on the pass. One zone, because that is one thing a cook is working through. */
    activeHeading: 'To make',
    activeEmpty: 'Nothing waiting.',
    /** The pinned zone: passed, waiting for a runner or waiter to take it. Never scrolls out of
     *  view under incoming work — see kitchen-screen.tsx's layout. */
    readyHeading: 'Ready',
    readyEmpty: 'Nothing ready.',
    /** Station tap: this line is cooked, awaiting the pass. */
    cookedButton: 'Cooked',
    /**
     * Pass tap: this line is confirmed and can leave the kitchen. Moves it to the Ready zone.
     *
     * UNIFIED 2026-09-01: was 'Ready to run' here and 'Out' on the bar — two words for ONE state
     * (order_lines.*_state = 'ready'), on two screens one person works in one shift. The wire
     * action is still `ready_to_run` / `out`: those are the API's vocabulary and changing them
     * would be a contract change, which this display-only redesign has no business making.
     */
    readyButton: 'Ready',
    /** Runner/waiter tap on a Ready line: it has physically been taken off the pass. Clears it
     *  from the Ready zone — without this a pinned zone never empties. */
    collectedButton: 'Collected',
    /**
     * SIGNED by the owner 2026-08-28. The per-table shortcut, on the card header, beside the table number. One tap for a
     * table whose whole ticket landed at once — it must not cost five taps — while every line keeps
     * its own button, because a salad and a steak do not finish together.
     *
     * Whoever writes this: it acts on EVERY OUTSTANDING LINE THIS CARD IS SHOWING and nothing else.
     * It is not "the whole order" and it is not "the whole table" — the bar's half of the same
     * order is untouched, and so is anything already cooked.
     */
    allCookedButton: 'All cooked',
    /**
     * SIGNED by the owner 2026-08-28. Same shortcut on the pass side of the board: every line this card is showing as
     * cooked-and-waiting goes ready to run at once.
     */
    allReadyButton: 'All ready',
    /** Same shortcut on the Ready zone: every line this table's Ready card is showing is
     *  collected at once. */
    allCollectedButton: 'All collected',
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
    /** The active zone: drinks not yet poured. Ages now (reversed 20260829, see bar-screen.tsx's
     *  own note) on later bands than the kitchen's — a warm beer is still a smaller problem than
     *  a cold steak, it just was not a reason to switch colour off entirely at real volume. */
    activeHeading: 'To make',
    activeEmpty: 'Nothing waiting.',
    /** The pinned zone: poured, waiting to be collected. Ages on the same clock and bands as the
     *  kitchen's Ready zone — a drink sitting uncollected is a different problem from one not yet
     *  made. */
    readyHeading: 'Ready',
    readyEmpty: 'Nothing ready.',
    /** The one tap that sends a drink to Ready. NOW PER LINE: a round is not poured all at once,
     *  and the label is still exactly what the tap does. */
    readyButton: 'Ready',
    /** Waiter/runner tap on a Ready drink: it has physically been taken off the bar. Clears it
     *  from the Ready zone. Same word the kitchen uses, on purpose — see the file docblock. */
    collectedButton: 'Collected',
    /**
     * SIGNED by the owner 2026-08-28. The per-round shortcut, matching the kitchen's per-table one: every line this round
     * card is showing goes out in one tap. The bar's half only — a kitchen line on the same order
     * is untouched.
     */
    allReadyButton: 'All ready',
    /** Same shortcut on the Ready zone: every drink this round's Ready card is showing is
     *  collected at once. */
    allCollectedButton: 'All collected',
    /** Same absent-table rule as the kitchen — see the note there. */
    tableLabel: (tableNumber: string) =>
      tableNumber.trim() === '' ? 'No table' : `Table ${tableNumber}`,
  },
  /**
   * The 12h partition, shared by both screens. DISPLAY ONLY -- these lines are still live work
   * and nothing about them has been collected, voided or written. The wording carries that: it
   * says UNRESOLVED, not "old" or "done", because a cook reading it must understand the board has
   * set them aside, not that the system has dealt with them.
   */
  older: {
    heading: 'Older unresolved',
    hint: 'not touched - still open',
  },
  /**
   * Shared by both screens — a route_to = 'unrouted' line must never read as ordinary work.
   * REWORDED 20260829160000 around the board rebuild's own language: "food nobody is making" —
   * this is money left on a table and a food-safety question at once, and it must outrank
   * lateness on the board. Still says what to do next, per house style.
   */
  unrouted: {
    heading: 'NOT SENT — nobody is making this',
    /** Loud, not silent: this is the whole point of the section existing. Says what to do next. */
    description: 'No station is set on these items. Set one on the menu item so they get made.',
    /**
     * PINNED, 2026-08-28: "it is the sentence that stops food going unseen and it is the kind
     * of thing that gets shortened out." Shown on EVERY unrouted row, not just the section
     * banner — the banner can be scrolled past; this cannot, because it sits on the item itself.
     */
    itemNote: 'Nobody is making this. Check the menu.',
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
    /** SIGNED by the owner 2026-08-28. Card-level: some of what you just tapped did not move. Shown with "N/M" beside it. */
    heading: 'Some did not send',
    /** SIGNED by the owner 2026-08-28. Row-level, on each individual line that was refused, so it is findable at 3m. */
    lineMarker: 'Not sent',
    /** SIGNED by the owner 2026-08-28. The button's own label while its bump is in flight and it is not tappable. */
    working: 'Sending',
  },
  age: {
    justNow: 'just now',
    minutes: (n: number) => `${n} min`,
  },
  /**
   * ADDED, second-pass board redesign (20260829). Shared by both boards' Ready/Waiting-for-
   * collection dispatch rows — "same language, same dimensions" applies to the row's own words
   * too, not just its layout.
   */
  dispatch: {
    /** The word between the item and its clock: "T12 · Ribeye MR · READY 02:11". State, not
     *  zone — the bar's zone is headed "Waiting for collection" but the dish itself is ready. */
    readyWord: 'READY',
    /**
     * The recoverable-tap window's own button. "A waiter who taps the wrong row has no way back
     * and no record on screen that it happened... the tap must be recoverable." One word, because
     * it sits on an already-narrow row beside a struck-through item name and a clock.
     */
    undoButton: 'Undo',
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
  /**
   * Shown instead of the board (and instead of notPaired/notEnabled, which are not yet known
   * either) from mount until the first fetch resolves. Not "Nothing waiting" -- that is a claim
   * about what the board found, and this is the moment before it has looked.
   */
  loading: {
    heading: 'Loading the board…',
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
