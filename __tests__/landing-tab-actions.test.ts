/**
 * #211 — the QR landing must not offer "Rejoin your tab" as the ONLY action when the customer is
 * standing at a different table.
 *
 * These import the shipped rule (`lib/tabs/landing-tab-actions.ts`), which the landing itself
 * imports, rather than restating the comparison. #205: five tests once stayed green against a
 * render site that had been reverted, because each carried its own copy of the rule.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the RULE. That
 * `app/menu/[restaurantId]/v2/page.tsx` calls it at both seams -- the render and the open-tab
 * lookup gate -- is covered by reading and by `tsc`, NOT by this file. Stated rather than implied.
 */
import {
  isStoredTabAtAnotherTable,
  resolveLandingTabActions,
} from '../lib/tabs/landing-tab-actions'

describe('isStoredTabAtAnotherTable', () => {
  it('is true when the stored tab belongs to a different table -- the whole point of #211', () => {
    expect(isStoredTabAtAnotherTable(3, 7)).toBe(true)
  })

  it('is false at the customer\'s own table, so today\'s rejoin card is unchanged', () => {
    expect(isStoredTabAtAnotherTable(7, 7)).toBe(false)
  })

  it('treats an UNKNOWN stored table as not-a-mismatch rather than guessing', () => {
    // A tab whose table_number we could not read must not produce "your tab is at Table null",
    // nor a second action pointing at a table we cannot name.
    expect(isStoredTabAtAnotherTable(null, 7)).toBe(false)
    expect(isStoredTabAtAnotherTable(undefined, 7)).toBe(false)
  })

  it('treats 0 and non-finite numbers as unknown on either side', () => {
    // tableNum > 0 is the landing's own precondition for showing any tab UI.
    expect(isStoredTabAtAnotherTable(0, 7)).toBe(false)
    expect(isStoredTabAtAnotherTable(3, 0)).toBe(false)
    expect(isStoredTabAtAnotherTable(Number.NaN, 7)).toBe(false)
  })
})

describe('resolveLandingTabActions', () => {
  it('offers rejoin only when the stored tab is at the scanned table', () => {
    expect(
      resolveLandingTabActions({ storedTabTable: 7, scannedTable: 7, scannedTableTab: 'no_open_tab' }),
    ).toBe('rejoin_only')
  })

  it('offers a SECOND action when the tables differ -- the dead end #211 is about', () => {
    const actions = resolveLandingTabActions({
      storedTabTable: 3,
      scannedTable: 7,
      scannedTableTab: 'no_open_tab',
    })
    expect(actions).not.toBe('rejoin_only')
    expect(actions).toBe('rejoin_or_start_here')
  })

  it('offers JOIN, never start, when the scanned table already has an open tab', () => {
    // THE LOAD-BEARING CASE. "Start a tab here" against an occupied table cannot create: it hits
    // idx_tabs_one_open_per_table and falls into POST /api/tabs's 23505 recovery branch, which
    // performs a PIN-LESS join (#218, open). Routing to a join instead reaches
    // POST /api/tabs/[tabId]/join, which enforces the PIN unconditionally since 237caec.
    expect(
      resolveLandingTabActions({ storedTabTable: 3, scannedTable: 7, scannedTableTab: 'open_tab' }),
    ).toBe('rejoin_or_join_here')
  })

  it('fails safe to JOIN when the scanned table state is unknown', () => {
    // Same reasoning: if we could not determine what is at this table, offer the action that
    // cannot reach the bypass.
    expect(
      resolveLandingTabActions({ storedTabTable: 3, scannedTable: 7, scannedTableTab: 'unknown' }),
    ).toBe('rejoin_or_join_here')
  })

  it('never offers start-here for an occupied table at ANY table pairing', () => {
    for (const [stored, scanned] of [[1, 2], [3, 7], [12, 4], [99, 1]]) {
      expect(
        resolveLandingTabActions({
          storedTabTable: stored,
          scannedTable: scanned,
          scannedTableTab: 'open_tab',
        }),
      ).toBe('rejoin_or_join_here')
    }
  })
})
