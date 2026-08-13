/**
 * Length cap for customer-written instruction text — the order-level box on the cart and the
 * per-item note on the cart row and in the item modal.
 *
 * 280 characters: long enough for the notes people actually write ("no sugar, oat milk, and
 * please keep the burger separate from the nuts") and short enough that a note stays readable
 * on a staff order card and on a 32-column thermal print.
 *
 * This is a UI cap only. The column is `text` and app/api/orders/route.ts does not validate
 * length, so a crafted request still stores anything it likes; see issue #129. Capping there
 * is a change to the order-creation path and was deliberately left out of the fix.
 */
export const MAX_INSTRUCTIONS_LENGTH = 280

/**
 * Trim and cap instruction text server-side, returning null for an empty note.
 *
 * The comment above records that capping was deliberately left out of the ORDER-CREATION
 * path, and that stands — POST /api/orders is untouched and #129 is still open. This exists
 * for the customer order-edit route, which is a new write path introduced after that
 * decision, and which feeds the same staff order card and 32-column thermal print. A new
 * door does not get to be the unvalidated one because an older door is.
 */
export function normalizeOrderInstructions(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  return text.slice(0, MAX_INSTRUCTIONS_LENGTH)
}
