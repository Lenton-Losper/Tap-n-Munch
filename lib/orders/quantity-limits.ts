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

import {
  capIdentity,
  lineQuantity,
  quantityOfLogicalItem,
  type ComparableLine,
} from './logical-item-identity'

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

/**
 * THE RESULTING-QUANTITY CAP (#307). Ruled 2026-08-17.
 *
 * `validateLineQuantity` caps ONE line. That is not the ceiling the customer experiences: the
 * additions path appends lots, so an order already holding 12 accepted another 12 and the customer
 * walked away with 24 under a cap of 20. Each call was individually legal; nothing looked at the
 * sum. Measured on staging: 2 + 20 = 22 against MAX_LINE_QUANTITY 20.
 *
 * So the cap is applied to the RESULTING logical-item quantity -- everything already on the order
 * plus everything proposed -- and the identity it groups by deliberately EXCLUDES price, because
 * two price lots must not each get a fresh ceiling (`lib/orders/logical-item-identity.ts`).
 *
 * This does NOT replace the per-line check. That stays as the hard server ceiling for a single
 * malformed line; this is the additional one that closes the sum.
 */
export type ResultingQuantityRefusal = {
  itemName: string
  /** What the order would hold if this were allowed. */
  resulting: number
  /** What it already holds. */
  existing: number
  /** The ceiling. */
  maximum: number
  /** How many more the customer may add. Never negative. */
  remaining: number
}

export type ResultingQuantityResult =
  | { ok: true }
  | { ok: false; refusal: ResultingQuantityRefusal }

/**
 * @param existingLines lines already stored on the order
 * @param additions     lines the customer is proposing to add
 *
 * Returns the FIRST logical item that would exceed the ceiling, so the customer is shown one clear
 * message rather than a list.
 */
export function validateResultingQuantities(
  existingLines: readonly ComparableLine[],
  additions: readonly ComparableLine[],
): ResultingQuantityResult {
  const proposed = Array.isArray(additions) ? additions : []
  const existing = Array.isArray(existingLines) ? existingLines : []

  // Sum the proposed lots per identity FIRST: two additions of the same item in one Save must be
  // counted together, or the sum is split across calls again in miniature.
  const proposedByIdentity = new Map<string, { qty: number; sample: ComparableLine }>()
  for (const line of proposed) {
    if (!line || typeof line !== 'object') continue
    const id = capIdentity(line)
    const entry = proposedByIdentity.get(id) ?? { qty: 0, sample: line }
    entry.qty += lineQuantity(line)
    proposedByIdentity.set(id, entry)
  }

  for (const [identity, { qty, sample }] of proposedByIdentity) {
    const already = quantityOfLogicalItem(existing, identity)
    const resulting = already + qty
    if (resulting > MAX_LINE_QUANTITY) {
      const name = String(
        (sample as { displayName?: unknown; name?: unknown }).displayName ??
          (sample as { name?: unknown }).name ??
          '',
      ).trim()
      return {
        ok: false,
        refusal: {
          itemName: name,
          resulting,
          existing: already,
          maximum: MAX_LINE_QUANTITY,
          remaining: Math.max(0, MAX_LINE_QUANTITY - already),
        },
      }
    }
  }

  return { ok: true }
}
