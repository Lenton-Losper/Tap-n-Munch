/**
 * #334 — customer-facing copy for the screens under `app/menu/**`.
 *
 * THE RULING, 2026-08-24: customer wording lives here, not inline in a screen. The gate scans for
 * prose in those paths and HARD FAILS the build, because a warning gets ignored within a month.
 *
 * WHY THIS EXISTS AT ALL. `'Order sent - waiting for the restaurant to confirm'` sat as a bare
 * literal inside ActiveOrderBanner and never passed sign-off — not because anyone decided to skip
 * it, but because `check-no-pending-copy.mjs` scans for a MARKER, and a string that never carried a
 * marker and never lived in a copy file cannot be found by any gate. Enforcement was opt-in, and
 * the one string that mattered had opted out.
 *
 * MOVING IS NOT REWRITING. Every value here is byte-identical to the literal it replaced. Anything
 * that needs wording work goes in carrying the `PENDING COPY` marker and blocks the production
 * deploy until the owner signs it — that is the existing gate doing its job, not a new obstacle.
 */
export const MENU_COPY = {
  // ---------------------------------------------------------------- receipt
  /** Renders on the receipt screen when a session has nothing live to show. */
  receiptNoActiveOrders: 'No active orders found.',
  /**
   * Fallback for a line whose name did not survive whatever produced it. Rare, and it is a
   * customer-visible fallback rather than a developer placeholder, so it belongs here.
   */
  receiptUnknownItem: 'Unknown Item',

  // ---------------------------------------------------------------- cart
  /**
   * Shown when the cart has no session to place an order against. Signed off 2026-08-24, and it
   * REPLACES wording rather than moving it: the old pair was 'Session error' / 'Please try again.',
   * which named no cause and offered a remedy that cannot work — retrying does not create a
   * session. Matches the wording already signed for my-orders.
   */
  cartSessionEndedTitle: 'session ended',
  cartSessionEndedBody: 'scan the QR code at your table to start again.',

  /**
   * PAYMENT METHOD COPY, keyed by SERVICE MODEL. Signed off by the owner 2026-08-24.
   *
   * These used to switch on `isKiosk` -- a CHANNEL flag, not a service model -- so a
   * counter-service venue ordering at a table was told "Staff will collect cash at your table",
   * promising a person who was never coming. It now derives from `restaurants.is_counter_service`.
   *
   * The distinction each pair carries is WHO MOVES. Counter variants never promise a person,
   * because a counter-service venue may have no table staff at all; "someone" appears only where
   * staff actually come to the table.
   */
  payCounterCashLabel: 'pay with cash',
  payCounterCashBody: 'pay at the counter when you collect your order',
  payCounterCardLabel: 'pay by card',
  payCounterCardBody: 'tap your card at the counter when you collect your order',
  payTableCashLabel: 'pay with cash',
  payTableCashBody: 'someone will come to your table to take payment',
  payTableCardLabel: 'pay by card',
  payTableCardBody: 'someone will bring a card machine to your table',

  /**
   * READY-TO-PAY OUTCOMES. Signed off 2026-08-24.
   *
   * "tab closed" rather than "ready to pay": the customer's concern is that they can no longer add
   * items, and that is what the body says. The failure body states the tab is still OPEN, because
   * after a failure the customer's real question is whether they still owe or can still order.
   */
  tabClosedTitle: 'tab closed',
  tabClosedTableBody: 'someone is on their way. you cannot add more items.',
  tabClosedCounterBody: 'pay at the counter when you are ready. you cannot add more items.',
  tabCloseFailedTitle: 'could not close your tab',
  tabCloseFailedBody: 'your tab is still open. please ask a member of staff.',
} as const

/**
 * NOT COPY. Strings inside `app/menu/**` that no human reads as prose, so the gate must not demand
 * they move. Kept SMALL and exact: a stale entry is a failure, the same way the pending-copy gate
 * treats a marker nobody removed.
 *
 * `throw new Error('...')` messages belong here. They are internal invariants — `customerSafeError`
 * maps anything reaching a customer to allowlisted wording, so the thrown text is never rendered.
 */
export const MENU_COPY_NOT_PROSE: readonly string[] = [
  'Failed to add to tab',
  'Failed to place order',
  'No order ID returned',
] as const
