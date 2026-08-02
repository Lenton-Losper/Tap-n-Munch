/**
 * Per-line quantity limits for customer-placed orders.
 *
 * Before this, `extractQuantity` in calculate-order-pricing.ts silently coerced anything
 * unusable to 1 and accepted any positive finite number: 9999 priced fine, so did 2.5, and a
 * negative or non-numeric quantity became a quiet quantity-1 order rather than an error.
 *
 * Deliberately a fixed cap rather than a per-restaurant setting: a configurable limit is a
 * settings surface, a migration and an admin UI, and the failure it prevents is a customer
 * typo or a malformed client — not a venue with genuinely unusual needs.
 *
 * Scoped to customer channels (QR table / kiosk). Staff POS goes through
 * app/api/terminal/orders and is intentionally NOT capped: ringing up 30 coffees for a large
 * table or a catering order is legitimate, and a staff member miskeying is caught by the
 * person standing in front of them.
 */

export const MIN_LINE_QUANTITY = 1
export const MAX_LINE_QUANTITY = 20

export type QuantityValidationResult =
  | { ok: true; quantity: number }
  | { ok: false; reason: string }

/**
 * Validate one line's quantity. Rejects rather than coercing, so a malformed client cannot
 * quietly turn "12" into "1" and hand the customer an order they did not place.
 */
export function validateLineQuantity(
  raw: unknown,
  itemName?: string,
): QuantityValidationResult {
  const label = itemName?.trim() ? `"${itemName.trim()}"` : 'an item'
  const quantity = Number(raw)

  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(quantity)) {
    return { ok: false, reason: `Please choose how many of ${label} you would like.` }
  }
  if (!Number.isInteger(quantity)) {
    return { ok: false, reason: `You can only order whole numbers of ${label}.` }
  }
  if (quantity < MIN_LINE_QUANTITY) {
    return { ok: false, reason: `Please order at least ${MIN_LINE_QUANTITY} of ${label}.` }
  }
  if (quantity > MAX_LINE_QUANTITY) {
    return {
      ok: false,
      reason:
        `You can order up to ${MAX_LINE_QUANTITY} of ${label} at a time. ` +
        `For a larger order, please ask a member of staff.`,
    }
  }
  return { ok: true, quantity }
}

/**
 * Validate every line. Returns the first problem, so the customer is shown one clear message
 * rather than a list.
 */
export function validateOrderQuantities(
  items: Array<Record<string, unknown>>,
): { ok: true } | { ok: false; reason: string } {
  for (const item of items) {
    const name =
      typeof item?.displayName === 'string'
        ? item.displayName
        : typeof item?.name === 'string'
          ? item.name
          : undefined
    const result = validateLineQuantity(item?.quantity, name)
    if (!result.ok) return { ok: false, reason: result.reason }
  }
  return { ok: true }
}

/** Clamp for UI controls, which should not let the customer reach an invalid value at all. */
export function clampLineQuantity(value: number): number {
  if (!Number.isFinite(value)) return MIN_LINE_QUANTITY
  return Math.min(MAX_LINE_QUANTITY, Math.max(MIN_LINE_QUANTITY, Math.floor(value)))
}
