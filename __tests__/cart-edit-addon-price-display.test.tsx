/**
 * #205 — the add-on list displayed CURRENT menu prices while charging STORED ones.
 *
 * Found while implementing #189's ruling, not reported by a customer, and filed separately so it
 * cannot close silently when #189 does.
 *
 * The mechanism, all in components/menu/item-detail-modal.tsx:
 *   selectedAddons is seeded from `editingLine.selected_addons` -- the prices actually shown
 *   the list is rendered from `item.addons`             -- the prices the menu holds TODAY
 *   the tick is decided by NAME alone                   -- so nothing in the row notices
 *
 * A retained add-on therefore rendered ticked, beside a figure that was not what it would be
 * charged at. This pins the rule ruled for it:
 *
 *   RETAINED add-on  -> the price it was added at
 *   UNTICKED add-on  -> the current menu price, i.e. what it would cost if you ticked it
 *
 * Tested at the pricing rule rather than through the DOM: the component pulls in the cart
 * context, the toast store and the image loader, none of which this rule depends on. What is
 * asserted is the exact expression the render uses.
 */

import { displayedAddonPrice } from '../lib/cart/addon-display-price'

type MenuItemAddon = { name: string; price: number }

/** What the line is actually charged, from item-detail-modal's computePrice. */
function chargedForAddons(selectedAddons: MenuItemAddon[]): number {
  return selectedAddons.reduce((sum, a) => sum + a.price, 0)
}

const MENU_TODAY: MenuItemAddon[] = [
  { name: 'Extra patty', price: 40 }, // was 35 when the line was added
  { name: 'Bacon', price: 20 },
  { name: 'Cheese', price: 12 },
]

/** What the customer was shown when they added the line. */
const STORED_SELECTION: MenuItemAddon[] = [{ name: 'Extra patty', price: 35 }]

describe('#205 — displayed add-on price matches what is charged', () => {
  it('a RETAINED add-on shows the price it was added at, not the new menu price', () => {
    const patty = MENU_TODAY[0]

    // The defect: this returned 40 while the line was charged 35.
    expect(displayedAddonPrice(patty, STORED_SELECTION)).toBe(35)
  })

  it('an UNTICKED add-on shows the current menu price', () => {
    const bacon = MENU_TODAY[1]

    // Not selected, so there is no quote to honour -- this is what it would cost if ticked.
    expect(displayedAddonPrice(bacon, STORED_SELECTION)).toBe(20)
  })

  it('THE INVARIANT: the sum of displayed prices equals what the line is charged', () => {
    // This is the property the customer can actually check, by adding up the ticked rows.
    const displayedForTicked = MENU_TODAY.filter((a) =>
      STORED_SELECTION.some((s) => s.name === a.name),
    ).reduce((sum, a) => sum + displayedAddonPrice(a, STORED_SELECTION), 0)

    expect(displayedForTicked).toBe(chargedForAddons(STORED_SELECTION))
  })

  it('re-ticking after un-ticking adopts the current price, and SAYS so', () => {
    // toggleAddon pushes the object from item.addons, so the re-added add-on is priced today.
    // That is intended -- a new tick is a new choice. What matters is that the displayed figure
    // moves with it, so the customer is not shown 35 while being charged 40.
    const afterUntick: MenuItemAddon[] = []
    const afterRetick: MenuItemAddon[] = [MENU_TODAY[0]]

    expect(displayedAddonPrice(MENU_TODAY[0], afterUntick)).toBe(40)
    expect(displayedAddonPrice(MENU_TODAY[0], afterRetick)).toBe(40)
    expect(chargedForAddons(afterRetick)).toBe(40)
  })

  it('a malformed stored price falls back to the menu rather than printing NaN', () => {
    const corrupt = [{ name: 'Extra patty', price: undefined as unknown as number }]

    expect(displayedAddonPrice(MENU_TODAY[0], corrupt)).toBe(40)
  })
})
