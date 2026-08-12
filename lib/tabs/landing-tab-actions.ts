/**
 * #211 — what the QR landing should offer when the customer already holds a tab.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE TERNARY
 *
 * The decision has three inputs and three outcomes, and getting it wrong in one direction routes
 * customers into an open PIN bypass (see START_HERE below). A test that re-implemented the
 * comparison in its own file would prove nothing about the screen -- #205's lesson, where five
 * tests stayed green against a render site that had been reverted, because the test carried its
 * own copy of the rule. The landing imports this, so a test that imports it is testing shipped
 * code.
 *
 * WHAT WAS WRONG
 *
 * `app/menu/[restaurantId]/v2/page.tsx` offered "Rejoin your tab" whenever a tab id was in
 * localStorage, with no reference to which table that tab belongs to, and it deliberately skipped
 * the scanned table's own open-tab lookup whenever a tab was stored. So a customer holding a tab
 * from table 3 who scanned table 7 was offered exactly one action -- rejoin table 3 -- and the
 * screen had not even asked what was happening at table 7.
 */

/** The scanned table has its own open tab, or it does not; we may also not know yet. */
export type ScannedTableTabState = 'open_tab' | 'no_open_tab' | 'unknown'

export type LandingTabActions =
  /** Stored tab belongs to this table (or its table is unknown). Today's behaviour. */
  | 'rejoin_only'
  /** Stored tab is elsewhere AND this table already has an open tab. */
  | 'rejoin_or_join_here'
  /** Stored tab is elsewhere and this table is free. */
  | 'rejoin_or_start_here'

export type LandingTabActionsInput = {
  /** `table_number` of the tab in localStorage. Null when unknown -- never inferred. */
  storedTabTable: number | null | undefined
  /** The table number encoded in the QR that was just scanned. */
  scannedTable: number
  /** What is waiting at the scanned table. */
  scannedTableTab: ScannedTableTabState
}

/**
 * Is the stored tab at a table other than the one just scanned?
 *
 * NULL-SAFE BY DESIGN. An unknown `storedTabTable` is NOT a mismatch: the screen falls back to
 * today's behaviour rather than inventing a mismatch out of missing data and telling a customer
 * their tab is somewhere it may not be. `0` is not a table -- the landing treats `tableNum > 0`
 * as the precondition for any tab UI at all, so a 0 on either side reads as unknown.
 */
export function isStoredTabAtAnotherTable(
  storedTabTable: number | null | undefined,
  scannedTable: number,
): boolean {
  if (storedTabTable == null) return false
  if (!Number.isFinite(storedTabTable) || !Number.isFinite(scannedTable)) return false
  if (storedTabTable <= 0 || scannedTable <= 0) return false
  return storedTabTable !== scannedTable
}

/**
 * THE ORDERING CONSTRAINT THIS ENCODES, and the reason the two "elsewhere" outcomes are distinct.
 *
 * `idx_tabs_one_open_per_table` is a hard unique index: a table may hold only one open tab. So
 * "start a tab here" against a table that already has one CANNOT create. It raises 23505, and
 * `POST /api/tabs`'s 23505 recovery branch hands back the existing tab with a fresh session token
 * and **no PIN check** -- #218, still open on production as of 2026-08-12 (`237caec` contained
 * `POST /api/tabs/[tabId]/join`, not this route).
 *
 * Collapsing the two outcomes into one "start here" button would therefore turn #211's fix into a
 * new funnel INTO that bypass. Routing the occupied case to a join instead reaches
 * `[tabId]/join`, which enforces the PIN unconditionally. That is why this returns three values
 * and not a boolean.
 *
 * `unknown` is treated as occupied for safety: if we could not determine what is at this table,
 * offering the action that cannot bypass anything is the safe default.
 */
export function resolveLandingTabActions({
  storedTabTable,
  scannedTable,
  scannedTableTab,
}: LandingTabActionsInput): LandingTabActions {
  if (!isStoredTabAtAnotherTable(storedTabTable, scannedTable)) return 'rejoin_only'
  return scannedTableTab === 'no_open_tab' ? 'rejoin_or_start_here' : 'rejoin_or_join_here'
}
