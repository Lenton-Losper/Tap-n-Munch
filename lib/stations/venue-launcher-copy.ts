/**
 * THE VENUE PAGE'S VIEW OF ITS OWN STATION SCREENS.
 *
 * ============================================================================================
 * WHAT THIS SOLVES, AND WHAT IT HONESTLY CANNOT
 * ============================================================================================
 *
 * On 2026-09-02 a kitchen screen standing in Riviera was paired to FNB ChowNow. Nothing said so
 * for 45 minutes, because the only place that fact existed was the screen's own token — and the
 * screen was showing an empty board, which looks exactly like a quiet shift.
 *
 * This panel puts that fact on the venue's page: which screens exist, what each is paired as, and
 * whether it has been seen recently. A wrong or missing pairing becomes visible from the
 * dashboard instead of only from the wall.
 *
 * IT CANNOT scope a board to a venue by link. Which restaurant a board shows is decided by the
 * terminal JWT the DEVICE holds, and that is the whole security model — a URL that could select a
 * venue would be a second, weaker way to answer the question the token already answers. So the
 * Open button opens the station on whatever computer clicks it, and the copy says so plainly
 * rather than implying a scoping that does not exist.
 *
 * WRITTEN FOR AN OWNER OR MANAGER reading a dashboard, not for a cook and not for us.
 */
export const VENUE_LAUNCHER_COPY = {
  heading: 'Kitchen and bar screens',
  description: 'Which screens this venue has, and what each one is set to show.',

  kitchenLabel: 'Kitchen',
  barLabel: 'Bar',

  /** No screen paired for this station. The common case for a venue that has not set one up. */
  nonePaired: 'No screen paired',
  nonePairedHint: 'Pair one from Settings, under Payment and terminals.',

  openKitchen: 'Open Kitchen',
  openBar: 'Open Bar',

  /**
   * THE SENTENCE THAT PREVENTS THE OBVIOUS MISREADING. Someone clicking Open from a venue's page
   * reasonably expects to see that venue. They will see whatever the computer they are sitting at
   * is paired to, which on an office laptop is usually nothing at all.
   */
  openNote:
    'Opens on the computer you are using now, and shows whatever that computer is paired to — not necessarily this venue. Install it on the screen that will keep it.',

  /** Two screens paired as the same station is legitimate, and worth saying out loud. */
  multiplePaired: (station: string) =>
    `More than one screen is paired as ${station}. They all show the same orders.`,

  seenRecently: 'Seen just now',
  seenAt: (when: string) => `Last seen ${when}`,
  neverSeen: 'Never connected',
  revoked: 'Revoked',
  awaitingActivation: 'Waiting for its code to be entered',
} as const
