export type PricedAddon = { name: string; price: number }

/**
 * What to PRINT next to an add-on in the item modal, which is not always what the menu says
 * today (#189 / #205).
 *
 * A line already in the cart is a quote, and that covers its add-ons exactly as it covers the
 * base price and the size modifier. The modal seeds `selectedAddons` from
 * `editingLine.selected_addons` -- the prices the customer was actually shown -- and charges
 * from that array. But it RENDERS the list from `item.addons`, which the cart page re-fetches,
 * so those carry today's prices.
 *
 * The two disagreed, and the tick is decided by NAME alone, so nothing in the row noticed: a
 * retained add-on rendered ticked beside "+N$20.00" while the line was charged N$15.00.
 *
 *   RETAINED  -> the price it was added at
 *   UNTICKED  -> the current menu price, i.e. what it would cost if you ticked it
 *
 * Both are then true statements about what that row means, and the printed figure always
 * matches what the modal charges.
 *
 * Extracted from the component deliberately: as a local closure it could only be tested by
 * restating it, and a test that restates its subject passes whatever the subject does.
 */
export function displayedAddonPrice(
  addon: PricedAddon,
  selectedAddons: ReadonlyArray<PricedAddon>,
): number {
  const retained = selectedAddons.find((a) => a.name === addon.name)
  const stored = Number(retained?.price)
  return retained && Number.isFinite(stored) ? stored : addon.price
}
