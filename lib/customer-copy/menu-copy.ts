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
