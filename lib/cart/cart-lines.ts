import type { CartItem } from '@/contexts/cart-context'
import { clampLineQuantity, MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'

/**
 * Identity of a cart line: everything a customer would read as "the same thing to make" --
 * menu item, variant selection, size, add-ons and the per-item note. Quantity, price and
 * display name are deliberately excluded; they are consequences of that identity, not part
 * of it. Add-on order is not meaningful, so it is sorted before comparing.
 *
 * Price stays OUT on purpose. #126's re-pricing bug is guarded at merge time instead (see
 * applyCartLineEdit): identity answers "is this the same thing to make", which is not the
 * same question as "may these two lines be folded into one".
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

/**
 * Cap ONE line's own quantity at MAX_LINE_QUANTITY, repricing from its own unit price.
 *
 * Repricing is not optional: capping the quantity without it leaves the subtotal charging for
 * units that are no longer on the line.
 *
 * Only ever downward -- anything at or under the cap is returned untouched, and `clamped` is
 * false, so "did not need capping" and "was capped" stay distinguishable.
 *
 * THIS IS THE PER-LINE CAP AND NOTHING ELSE, and the distinction is load-bearing. Two
 * different questions resolve in opposite directions:
 *
 *   one line's OWN quantity is over the cap  -> clamp it down (here, and in applyCartLineEdit)
 *   FOLDING two lines would cross the cap    -> refuse the fold, leave two lines
 *
 * Clamping a SUM destroys units the customer already had and never tells them which ones, so
 * the fold case must never come here. It is handled where folds happen: the guard below in
 * applyCartLineEdit ("THE CAP APPLIES PER LINE, NOT ACROSS MATCHING LINES") for the edit path,
 * and findMergeableLineIndex in lib/cart/cart-line-identity.ts, which skips an over-cap
 * candidate rather than merging into it, for the add path.
 *
 * WHY THE ADD PATH CALLS THIS TOO. findMergeableLineIndex guards the FOLD, not the incoming
 * line, so a single over-cap line appended straight past it. Both of today's add callers
 * happen to satisfy the cap on their own -- ItemDetailModal's + control stops at
 * MAX_LINE_QUANTITY, browse's quick-add hardcodes 1 -- but those are the callers' invariants,
 * not the cart's, and a caller added later would have to remember a rule nothing enforced.
 */
export function capCartLine(line: CartItem): { line: CartItem; clamped: boolean } {
  const requested = Number(line.quantity) || 0
  if (requested <= MAX_LINE_QUANTITY) {
    return { line, clamped: false }
  }

  const unitPrice = requested > 0 ? Number(line.subtotal || 0) / requested : 0
  const quantity = clampLineQuantity(requested)

  return {
    line: {
      ...line,
      quantity,
      subtotal: Math.round(unitPrice * quantity * 100) / 100,
    },
    clamped: true,
  }
}

export type CartLineEditResult = {
  items: CartItem[]
  /** True when the edit collided with an existing line and the two were folded into one. */
  merged: boolean
  /**
   * True when the EDITED LINE's own quantity was capped at MAX_LINE_QUANTITY. This is the
   * per-line cap and it is this function's job, not the caller's.
   *
   * It is not set by a refused fold: an over-cap collision leaves two lines rather than
   * capping a combined quantity, so nothing is clamped there. See `refusedBecause`.
   */
  clamped: boolean
  /**
   * Why a collision was deliberately NOT folded. Absent when nothing was refused, so
   * "collided with nothing" and "collided and was refused" are distinguishable -- without it
   * both look like `merged: false` and the customer is left with two identical-looking rows
   * and no explanation.
   *
   * 'cap'   -- folding would have taken one line past MAX_LINE_QUANTITY
   * 'price' -- the two lines are priced differently per unit
   */
  refusedBecause?: 'cap' | 'price'
}

/**
 * Apply an edited line back into the cart.
 *
 * An edit can make line A identical to line B ("Regular" changed to "Large" when a Large is
 * already in the cart). Replacing in place would leave two rows a customer cannot tell apart
 * -- the duplicate-line state #133 removed from the add path -- so identical lines are folded
 * into the earlier of the two positions, keeping the cart order stable.
 *
 * Two things stop a fold: a combined quantity over MAX_LINE_QUANTITY, and two lines priced
 * differently per unit. Both leave the cart as two lines rather than merging on terms the
 * customer did not agree to.
 *
 * The edited line's OWN quantity is capped at MAX_LINE_QUANTITY (the server rejects more) and
 * `clamped` reports it.
 */
export function applyCartLineEdit(
  items: CartItem[],
  index: number,
  edited: CartItem,
): CartLineEditResult {
  const requestedLineQuantity = Number(edited.quantity) || 0
  const unitPrice = requestedLineQuantity > 0 ? Number(edited.subtotal || 0) / requestedLineQuantity : 0

  /**
   * THE PER-LINE CAP IS ENFORCED HERE, NOT LEFT TO THE CALLER (#126).
   *
   * The modal's + control already stops at MAX_LINE_QUANTITY, so an over-cap edit does not
   * arrive from it in practice. That is the modal's invariant, not this function's. Every edit
   * path is reconciled here, so this is where the cap is applied -- a shared function does not
   * trust its callers to have applied it, and a caller added later inherits the cap instead of
   * having to remember it.
   *
   * The cap and its repricing are capCartLine above, shared with the add path so the two ways
   * into the cart cannot come to disagree about what the maximum is.
   */
  const { line: applied, clamped: lineWasCapped } = capCartLine(edited)

  const next = [...items]
  next[index] = applied

  const collisions = next
    .map((_, i) => i)
    .filter((i) => i !== index && sameCartLine(next[i], applied))

  if (collisions.length === 0) {
    return { items: next, merged: false, clamped: lineWasCapped }
  }

  const editedQuantity = Number(applied.quantity) || 0
  const requestedQuantity = collisions.reduce(
    (sum, i) => sum + (Number(next[i].quantity) || 0),
    editedQuantity,
  )

  /**
   * DO NOT FOLD LINES THAT COST DIFFERENT AMOUNTS PER UNIT (#126).
   *
   * The fold applied the EDITED line's unit price to the combined quantity, so a line the
   * customer had confirmed at one price was silently re-priced at another. Identity cannot
   * catch this -- two lines can be the same thing to make and still be priced differently
   * (a stale line, a since-changed menu price). So the guard belongs here: same thing to
   * make AND same unit price, or they stay two lines.
   */
  const unitOf = (l: CartItem) => {
    const q = Number(l.quantity) || 0
    return q > 0 ? Math.round((Number(l.subtotal || 0) / q) * 100) : 0
  }
  const editedUnit = unitOf(applied)
  if (collisions.some((i) => unitOf(next[i]) !== editedUnit)) {
    return { items: next, merged: false, clamped: lineWasCapped, refusedBecause: 'price' }
  }

  /**
   * THE CAP APPLIES PER LINE, NOT ACROSS MATCHING LINES (#126).
   *
   * Clamping the SUM silently destroyed paid-for units: two lines of 8 folded to 16 and were
   * capped back to the maximum, and the customer was never told which units vanished. Two
   * lines of the same item are legitimately two lines, and the server accepts each on its own
   * terms -- so when the combined quantity would exceed the cap, leave them as separate lines
   * rather than merging and discarding the overflow.
   */
  if (requestedQuantity > MAX_LINE_QUANTITY) {
    return { items: next, merged: false, clamped: lineWasCapped, refusedBecause: 'cap' }
  }
  const quantity = clampLineQuantity(requestedQuantity)

  const mergedLine: CartItem = {
    ...applied,
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

  return { items: out, merged: true, clamped: lineWasCapped || quantity < requestedQuantity }
}
