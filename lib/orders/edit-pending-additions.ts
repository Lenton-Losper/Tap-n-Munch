/**
 * "+ Add something" — the items a customer has picked for an order they are EDITING, before Save.
 *
 * RULED by the human 2026-08-16: *"'+ Add something' inside the editor opens the menu in picker
 * mode and returns to the PENDING edit, not to the cart. Nothing commits until Save."*
 *
 * THE PROBLEM THIS MODULE EXISTS FOR. The editor is React state inside `OrderEditPanel`. The
 * menu is a different ROUTE. Going to the menu unmounts the panel — which also releases the edit
 * lock, deliberately, so a customer who wanders off does not hold an order hostage for three
 * minutes. So the pending edit cannot live in component state across the round trip, and it must
 * not live on the server either, because nothing is supposed to commit until Save.
 *
 * `sessionStorage` is the right home for exactly that lifetime: it survives a route change and a
 * refresh, and it dies with the browser tab. It is keyed per ORDER, so two orders being edited in
 * two tabs cannot collide, and so an abandoned pick on order A never appears on order B.
 *
 * WHAT IS STORED IS A CLIENT ITEM, NOT A PRICE. The same shape `POST /api/orders` accepts. The
 * server prices every addition against the live menu at commit (`applyEditAdditions`), so
 * whatever `basePrice` ends up in here is decoration — and the simulation asserts that by sending
 * 0.01 and watching the menu price come back.
 *
 * EVERY READ AND WRITE IS GUARDED. `sessionStorage.setItem` throws in some privacy modes, and an
 * unguarded write inside a React initialiser would blank the whole `/menu` tree rather than lose
 * a pick. Losing the pick is the correct failure here.
 */

export const EDIT_PENDING_ADDITIONS_PREFIX = 'flashtap_edit_additions_'

/** The query parameter the editor sets on its way to the menu. */
export const EDIT_PICK_PARAM = 'pickFor'

export type PendingAddition = Record<string, unknown>

function keyFor(orderId: string): string {
  return `${EDIT_PENDING_ADDITIONS_PREFIX}${String(orderId || '').trim()}`
}

export function readPendingAdditions(orderId: string): PendingAddition[] {
  if (typeof window === 'undefined') return []
  const id = String(orderId || '').trim()
  if (!id) return []
  try {
    const raw = window.sessionStorage.getItem(keyFor(id))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingAddition[]) : []
  } catch {
    // Unparseable or unavailable. An empty list is the safe answer: the customer sees their pick
    // missing and can pick again, which is strictly better than a crash on the editor.
    return []
  }
}

export function writePendingAdditions(orderId: string, additions: PendingAddition[]): void {
  if (typeof window === 'undefined') return
  const id = String(orderId || '').trim()
  if (!id) return
  try {
    if (additions.length === 0) window.sessionStorage.removeItem(keyFor(id))
    else window.sessionStorage.setItem(keyFor(id), JSON.stringify(additions))
  } catch {
    /* privacy mode, or quota. Losing the pick is the correct failure. */
  }
}

export function appendPendingAddition(orderId: string, addition: PendingAddition): void {
  writePendingAdditions(orderId, [...readPendingAdditions(orderId), addition])
}

export function clearPendingAdditions(orderId: string): void {
  writePendingAdditions(orderId, [])
}

/**
 * The client item shape, from whatever the item sheet produced.
 *
 * Deliberately NOT a pass-through of the cart item: the cart's shape carries `subtotal`,
 * `base_price` and other client-computed money, and copying it wholesale into an edit payload
 * would suggest those figures mean something on the way in. Only the fields the SERVER prices
 * from are carried.
 */
export function toPendingAddition(cartItem: Record<string, unknown>): PendingAddition {
  return {
    menuItemId: cartItem.menu_item_id ?? cartItem.menuItemId ?? '',
    name: cartItem.name ?? '',
    displayName: cartItem.display_name ?? cartItem.displayName ?? cartItem.name ?? '',
    quantity: Number(cartItem.quantity) || 1,
    selectedVariants: cartItem.selected_variants ?? cartItem.selectedVariants ?? {},
    size:
      (cartItem.selected_size as { name?: unknown } | undefined)?.name ??
      cartItem.size ??
      null,
    addons: cartItem.selected_addons ?? cartItem.addons ?? [],
    specialInstructions: cartItem.special_instructions ?? cartItem.specialInstructions ?? '',
  }
}
