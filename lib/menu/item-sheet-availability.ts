/**
 * One predicate for "may this customer open the item sheet for this item?".
 *
 * The redesign makes EVERY menu item open the same configuration sheet, and makes the whole card
 * tappable rather than only the round `+` button. That creates a second entry point into the same
 * action, and two entry points that compute their own availability drift apart -- the button greys
 * out and the card still opens, or the reverse. #272 is the live instance of exactly that shape:
 * the inline Add button checked `out_of_stock` and the modal's own Add button did not, so an item
 * the checkout would refuse could still be put in a cart.
 *
 * So the rule lives here, once. `renderAddButton`'s `disabled` and the card's `onClick` both call
 * it, and a test binds to this function rather than restating the condition.
 *
 * NOTE: this answers "can the sheet OPEN". It deliberately does not repeat
 * `isChargeableMenuStatus`, which is the funnel guard inside `handleAddToCart` and is the last
 * word on whether an item may enter a cart at all -- that check must stay where every path
 * converges, not be duplicated into a UI predicate that a future entry point might skip.
 */

/** Tab statuses in which the customer may no longer add anything to the tab. */
export const CLOSED_TAB_STATUSES_FOR_ORDERING = [
  'settled',
  'closed',
  'completed',
  'cancelled',
] as const

export type ItemSheetAvailabilityInput = {
  /** The customer holds an active tab on this table. */
  isInTab: boolean
  /** Kiosk mode orders without a tab. */
  isKiosk: boolean
  /** `menu_items.status` for the item. */
  itemStatus: string | null | undefined
  /** True when the item has a required variant group with nothing selected. */
  requiredVariantMissing: boolean
  /** `tabs.status`, as the browse page holds it. */
  tabStatus: string | null | undefined
}

export function isTabClosedForOrdering(tabStatus: string | null | undefined): boolean {
  return (CLOSED_TAB_STATUSES_FOR_ORDERING as readonly string[]).includes(
    String(tabStatus ?? '').toLowerCase()
  )
}

export function canOpenItemSheet(input: ItemSheetAvailabilityInput): boolean {
  if (!input.isInTab && !input.isKiosk) return false
  if (input.itemStatus === 'out_of_stock') return false
  if (input.requiredVariantMissing) return false
  if (isTabClosedForOrdering(input.tabStatus)) return false
  return true
}
