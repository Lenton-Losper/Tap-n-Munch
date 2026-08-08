import type { CartItem } from '@/contexts/cart-context'
import { clampLineQuantity } from '@/lib/orders/quantity-limits'

/**
 * Identity of a cart line: everything a customer would read as "the same thing to make" --
 * menu item, variant selection, size, add-ons and the per-item note. Quantity, price and
 * display name are deliberately excluded; they are consequences of that identity, not part
 * of it. Add-on order is not meaningful, so it is sorted before comparing.
 */
function lineIdentity(line: CartItem): string {
  const variants = line.selected_variants ?? {}
  const variantKey = Object.keys(variants)
    .sort()
    .map((key) => `${key}=${String(variants[key] ?? '')}`)
    .join('|')
  const addonKey = (line.selected_addons ?? [])
    .map((addon) => String(addon?.name ?? ''))
    .sort()
    .join('|')
  const sizeKey = line.selected_size?.name ?? ''
  const note = (line.special_instructions ?? '').trim()

  return [line.menu_item_id, variantKey, sizeKey, addonKey, note].join('::')
}

export function sameCartLine(a: CartItem, b: CartItem): boolean {
  return lineIdentity(a) === lineIdentity(b)
}

export type CartLineEditResult = {
  items: CartItem[]
  /** True when the edit collided with an existing line and the two were folded into one. */
  merged: boolean
  /** True when the merged quantity had to be capped at MAX_LINE_QUANTITY. */
  clamped: boolean
}

/**
 * Apply an edited line back into the cart.
 *
 * An edit can make line A identical to line B ("Regular" changed to "Large" when a Large is
 * already in the cart). Replacing in place would leave two rows a customer cannot tell apart
 * -- the duplicate-line state #133 removed from the add path -- so identical lines are folded
 * into the earlier of the two positions, keeping the cart order stable.
 *
 * The merged quantity is capped at MAX_LINE_QUANTITY (the server rejects more), and `clamped`
 * reports that so the caller can say so rather than silently dropping units.
 */
export function applyCartLineEdit(
  items: CartItem[],
  index: number,
  edited: CartItem,
): CartLineEditResult {
  const next = [...items]
  next[index] = edited

  const collisions = next
    .map((_, i) => i)
    .filter((i) => i !== index && sameCartLine(next[i], edited))

  if (collisions.length === 0) {
    return { items: next, merged: false, clamped: false }
  }

  // Price per unit comes from the edited line, which is the one the customer just confirmed.
  const editedQuantity = Number(edited.quantity) || 0
  const unitPrice = editedQuantity > 0 ? Number(edited.subtotal || 0) / editedQuantity : 0
  const requestedQuantity = collisions.reduce(
    (sum, i) => sum + (Number(next[i].quantity) || 0),
    editedQuantity,
  )
  const quantity = clampLineQuantity(requestedQuantity)

  const mergedLine: CartItem = {
    ...edited,
    quantity,
    subtotal: Math.round(unitPrice * quantity * 100) / 100,
  }

  const keepAt = Math.min(index, ...collisions)
  const dropped = new Set([index, ...collisions])
  const out: CartItem[] = []
  next.forEach((line, i) => {
    if (i === keepAt) {
      out.push(mergedLine)
      return
    }
    if (dropped.has(i)) return
    out.push(line)
  })

  return { items: out, merged: true, clamped: quantity < requestedQuantity }
}
