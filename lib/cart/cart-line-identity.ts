/**
 * When are two cart lines the same line?
 *
 * Issue #133: `addItem` appended unconditionally, so tapping + twice gave two
 * "Cappuccino - Large ×1" cards the customer could not combine. The fix is to merge — but
 * merging on `menu_item_id` alone would fold a Large into a Small and change what the customer
 * is charged, which is a worse bug than the one being fixed.
 *
 * The rule here is: two lines are the same line exactly when they would RENDER identically on
 * the cart page. That page shows `display_name || name`, the size, the add-ons, the per-item
 * note and the money (app/menu/[restaurantId]/cart/page.tsx). So all of those are part of the
 * identity, plus `selected_variants` — not rendered on its own, but it is what the browse
 * quick-add folds into `display_name`, and it is sent to the server as part of the line.
 *
 * `base_price` is included so that if the catalog price moves mid-session, the two adds stay on
 * separate lines rather than being averaged into one. Presentation-only fields (`image_url`) are
 * not part of the identity.
 *
 * Two details that would otherwise produce spurious separate lines:
 *  - add-ons are sorted, so selecting {oat, shot} and {shot, oat} is one line;
 *  - variant entries are sorted by key, because object key order is not meaningful;
 *  - the note is trimmed, so "no sugar" and "no sugar " are one line. It is NOT lower-cased:
 *    collapsing "No nuts" into "no nuts" would mean discarding one of two notes a customer
 *    deliberately wrote differently, and these go to a kitchen.
 */
import type { CartItem } from '@/contexts/cart-context'
import { MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'

function addonKey(addons: CartItem['selected_addons']): Array<[string, unknown]> {
  return (Array.isArray(addons) ? addons : [])
    .map((addon) => [String(addon?.name ?? ''), addon?.price ?? null] as [string, unknown])
    .sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])))
}

function variantKey(variants: CartItem['selected_variants']): Array<[string, unknown]> {
  if (!variants || typeof variants !== 'object') return []
  return Object.entries(variants)
    .map(([k, v]) => [String(k), v] as [string, unknown])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/** Stable string identity for a cart line. Equal strings mean "the customer sees one line". */
export function cartLineIdentity(item: CartItem): string {
  return JSON.stringify([
    String(item.menu_item_id ?? ''),
    String(item.display_name || item.name || ''),
    Number.isFinite(item.base_price) ? item.base_price : null,
    item.selected_size
      ? [String(item.selected_size.name ?? ''), item.selected_size.price_modifier ?? null]
      : null,
    addonKey(item.selected_addons),
    variantKey(item.selected_variants),
    String(item.special_instructions ?? '').trim(),
  ])
}

/**
 * Index of the line `incoming` should merge into, or -1 to append.
 *
 * A candidate whose quantity would exceed MAX_LINE_QUANTITY is skipped rather than clamped.
 * app/api/orders rejects the WHOLE order when any line exceeds that cap, so merging past it
 * would turn an order that is accepted today into a 400 the customer cannot clear — the cart
 * page has no quantity stepper, so their only recourse would be deleting the line outright.
 * Appending in that corner reproduces exactly today's behaviour.
 */
export function findMergeableLineIndex(items: CartItem[], incoming: CartItem): number {
  const key = cartLineIdentity(incoming)
  const incomingQty = Number(incoming.quantity) || 0

  for (let i = 0; i < items.length; i++) {
    if (cartLineIdentity(items[i]) !== key) continue
    if ((Number(items[i].quantity) || 0) + incomingQty > MAX_LINE_QUANTITY) continue
    return i
  }
  return -1
}
