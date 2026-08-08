/**
 * Length cap for customer-written instruction text — the order-level box on the cart and the
 * per-item note on the cart row and in the item modal.
 *
 * 280 characters: long enough for the notes people actually write ("no sugar, oat milk, and
 * please keep the burger separate from the nuts") and short enough that a note stays readable
 * on a staff order card and on a 32-column thermal print.
 *
 * Enforced in the UI by `maxLength` on the three textareas, and on the server by
 * validateOrderInstructionLengths below — `maxLength` is an attribute on someone else's
 * browser, and the column is `text`, so without the server half a crafted request stores
 * whatever it likes (issue #129).
 */
export const MAX_INSTRUCTIONS_LENGTH = 280

export type InstructionsValidationResult = { ok: true } | { ok: false; reason: string }

/**
 * Measured on the raw string, with no trim, so the server boundary is exactly the boundary the
 * textarea enforces: a note the UI accepted can never be refused here.
 */
function isOverCap(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false
  return String(raw).length > MAX_INSTRUCTIONS_LENGTH
}

/**
 * Rejects rather than truncating, for two reasons.
 *
 * Truncating would silently rewrite the customer's own words — an allergy note is the obvious
 * case — and tell neither them nor the kitchen that it happened. And rejecting cannot cost a
 * real customer an order: every live caller of app/api/orders posts from a textarea already
 * capped at MAX_INSTRUCTIONS_LENGTH, so only a client that is not ours can exceed it.
 *
 * Same judgement, and the same shape, as validateOrderQuantities in ./quantity-limits.
 */
export function validateOrderInstructionLengths(
  orderInstructions: unknown,
  items: unknown,
): InstructionsValidationResult {
  if (isOverCap(orderInstructions)) {
    return {
      ok: false,
      reason:
        `Please keep your note for the kitchen to ${MAX_INSTRUCTIONS_LENGTH} characters or ` +
        `fewer, then try again.`,
    }
  }

  for (const entry of Array.isArray(items) ? items : []) {
    const item = (entry ?? {}) as Record<string, unknown>
    // Both spellings, checked independently rather than one falling back to the other: the wire
    // format is specialInstructions, the cart item's own field is special_instructions, and
    // calculate-order-pricing already accepts either for its other fields. A payload carrying
    // an empty specialInstructions alongside a long special_instructions must not slip through,
    // and both survive the `{...item}` spread into the stored items JSON.
    if (!isOverCap(item.specialInstructions) && !isOverCap(item.special_instructions)) continue

    const name =
      (typeof item.displayName === 'string' && item.displayName.trim()) ||
      (typeof item.name === 'string' && item.name.trim()) ||
      ''
    const label = name ? `"${name}"` : 'an item'
    return {
      ok: false,
      reason:
        `Please keep your note for ${label} to ${MAX_INSTRUCTIONS_LENGTH} characters or ` +
        `fewer, then try again.`,
    }
  }

  return { ok: true }
}
