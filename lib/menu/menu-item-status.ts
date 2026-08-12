/**
 * ONE source of truth for what a `menu_items.status` value MEANS.
 *
 * #272. Before this module the rule existed twice, written independently and in opposite
 * polarities:
 *
 *   - browse  — a DENYLIST in `lib/supabase/menu.ts` (`isCustomerMenuItemVisible`):
 *               everything EXCEPT 'hidden' was shown to the customer.
 *   - pricing — an ALLOWLIST in `lib/orders/calculate-order-pricing.ts`
 *               (`isChargeableMenuStatus`): only 'available' | 'active' could be charged.
 *
 * Every status in NEITHER set fell through the gap: it rendered on the QR menu with a live
 * Add button, went into the cart at its listed price, and was then hard-rejected at order
 * submission with `UnmatchedMenuItemError`. Measured on production Riviera 2026-08-12:
 * 'Cappucinno' (inactive, N$45) and 'Duck Confit' (out_of_stock, N$380).
 *
 * TWO COPIES OF THE RULE IS WHAT PRODUCED THE GAP, so both sides now read this table and
 * nothing else. Adding a status here forces BOTH answers to be declared in one place; there
 * is no longer a way to declare one and silently inherit the other.
 *
 * `menu_items.status` has NO CHECK constraint (`supabase/schema.sql:502`, DB default
 * 'active', while the admin UI writes 'available' | 'out_of_stock' | 'hidden'). It is
 * therefore free text, and an unknown value is a value nobody has decided about yet.
 * Unknown FAILS CLOSED: not shown, not chargeable. A customer never sees an item the
 * checkout would refuse.
 */

type MenuItemStatusRule = {
  /** Appears on the customer QR menu at all. */
  visible: boolean
  /** May be priced and charged by `calculateOrderPricing`. */
  chargeable: boolean
}

/**
 * The invariant this table must satisfy, asserted in
 * `__tests__/menu-item-status-parity.test.ts`: `chargeable` implies `visible`. An item the
 * checkout accepts must be one the customer could actually see and choose.
 *
 * The converse is deliberately allowed, and 'out_of_stock' is the one live instance:
 * visible WITHOUT being chargeable — see DISPLAY-ONLY below.
 */
const MENU_ITEM_STATUS_RULES: Record<string, MenuItemStatusRule> = {
  // The schema default is 'active'; the admin UI writes 'available'. Both mean orderable,
  // and both have to stay — 193 of Riviera's 198 items are 'active'.
  available: { visible: true, chargeable: true },
  active: { visible: true, chargeable: true },

  // DISPLAY-ONLY. Deliberately shown but not orderable: the browse page renders an
  // "Out of stock" badge and a disabled Add button (app/menu/[restaurantId]/browse/page.tsx).
  // That is a pre-existing, deliberate affordance — the customer learns the dish exists —
  // so #272 keeps it rather than deleting it. `handleAddToCart` enforces the other half.
  out_of_stock: { visible: true, chargeable: false },

  // Withdrawn from the menu entirely.
  hidden: { visible: false, chargeable: false },
  inactive: { visible: false, chargeable: false },
  archived: { visible: false, chargeable: false },
}

const UNKNOWN_STATUS_RULE: MenuItemStatusRule = { visible: false, chargeable: false }

/**
 * Null, undefined and '' mean 'available'.
 *
 * This is NOT a new decision — it is exactly what both original predicates did
 * (`String(status || 'available').toLowerCase()`), preserved verbatim so that this refactor
 * changes behaviour ONLY through the table above. Neither environment currently holds a
 * null or empty status (staging 30/30 and production 198/198 accounted for, 2026-08-12).
 */
export function normalizeMenuItemStatus(status: string | null | undefined): string {
  return String(status || 'available').toLowerCase()
}

function ruleFor(status: string | null | undefined): MenuItemStatusRule {
  return MENU_ITEM_STATUS_RULES[normalizeMenuItemStatus(status)] ?? UNKNOWN_STATUS_RULE
}

/** Does an item with this status belong on the customer menu at all? */
export function isCustomerVisibleMenuStatus(status: string | null | undefined): boolean {
  return ruleFor(status).visible
}

/** May an item with this status be priced and charged? */
export function isChargeableMenuStatus(status: string | null | undefined): boolean {
  return ruleFor(status).chargeable
}

/**
 * Visible but NOT chargeable — render it, but never let it into a cart.
 * Today that is 'out_of_stock' alone.
 */
export function isDisplayOnlyMenuStatus(status: string | null | undefined): boolean {
  const rule = ruleFor(status)
  return rule.visible && !rule.chargeable
}

/** Every status this table has an opinion about. Exported so tests can enumerate it. */
export const KNOWN_MENU_ITEM_STATUSES = Object.keys(MENU_ITEM_STATUS_RULES)
