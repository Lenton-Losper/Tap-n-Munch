/**
 * Binds to lib/menu/item-sheet-availability.ts rather than restating its condition.
 *
 * The point of the module is that the `+` button and the tappable card cannot disagree, so the
 * test that matters is the one asserting a single answer per input -- if the rule is edited to
 * let one caller through and not the other, these fail.
 */
import {
  canOpenItemSheet,
  isTabClosedForOrdering,
  CLOSED_TAB_STATUSES_FOR_ORDERING,
  type ItemSheetAvailabilityInput,
} from '@/lib/menu/item-sheet-availability'

const available: ItemSheetAvailabilityInput = {
  isInTab: true,
  isKiosk: false,
  itemStatus: 'available',
  requiredVariantMissing: false,
  tabStatus: 'open',
}

describe('canOpenItemSheet', () => {
  it('opens for an available item on an open tab', () => {
    expect(canOpenItemSheet(available)).toBe(true)
  })

  it('opens in kiosk mode with no tab', () => {
    expect(canOpenItemSheet({ ...available, isInTab: false, isKiosk: true, tabStatus: null })).toBe(
      true
    )
  })

  it('refuses when the customer has neither a tab nor kiosk mode', () => {
    expect(canOpenItemSheet({ ...available, isInTab: false, isKiosk: false })).toBe(false)
  })

  it('refuses an out_of_stock item', () => {
    expect(canOpenItemSheet({ ...available, itemStatus: 'out_of_stock' })).toBe(false)
  })

  it('refuses while a required variant group has no selection', () => {
    expect(canOpenItemSheet({ ...available, requiredVariantMissing: true })).toBe(false)
  })

  it.each(CLOSED_TAB_STATUSES_FOR_ORDERING)('refuses on a %s tab', (status) => {
    expect(canOpenItemSheet({ ...available, tabStatus: status })).toBe(false)
  })

  it('matches tab status case-insensitively, as the render site did', () => {
    expect(canOpenItemSheet({ ...available, tabStatus: 'SETTLED' })).toBe(false)
    expect(isTabClosedForOrdering('Closed')).toBe(true)
  })

  it('treats a null/undefined tab status as not-closed', () => {
    expect(isTabClosedForOrdering(null)).toBe(false)
    expect(isTabClosedForOrdering(undefined)).toBe(false)
  })

  it('does NOT decide chargeability -- that guard stays in the handleAddToCart funnel', () => {
    // An 'inactive' item is refused by isChargeableMenuStatus inside handleAddToCart (#272).
    // This predicate deliberately lets it through, so the funnel remains the single place
    // that answers "may this enter a cart".
    expect(canOpenItemSheet({ ...available, itemStatus: 'inactive' })).toBe(true)
  })
})
