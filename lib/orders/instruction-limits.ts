/**
 * Length cap for customer-written instruction text — the order-level box on the cart and the
 * per-item note on the cart row and in the item modal.
 *
 * 280 characters: long enough for the notes people actually write ("no sugar, oat milk, and
 * please keep the burger separate from the nuts") and short enough that a note stays readable
 * on a staff order card and on a 32-column thermal print.
 *
 * NO LONGER A UI CAP ONLY. app/api/orders/route.ts now normalises through the helper below, so
 * the order-CREATION path is bounded too (#129, 2026-08-19).
 *
 * The note this replaces said capping the creation path "was deliberately left out of the fix"
 * and pointed at #129 as still open. That was a scoping decision for that change, not a ruling
 * against ever doing it — and #129's own prescription is "maxLength on both textareas plus a
 * server-side slice". The deferral is now discharged rather than overridden.
 */
export const MAX_INSTRUCTIONS_LENGTH = 280

/**
 * Trim and cap instruction text server-side, returning null for an empty note.
 *
 * Used by BOTH write paths as of 2026-08-19: the customer order-edit route, and POST
 * /api/orders. One helper, so the two doors cannot disagree about the limit.
 *
 * The older note here said POST /api/orders was untouched. It no longer is, and leaving that
 * sentence in place would have been the more expensive kind of stale comment — one asserting a
 * gap that has been closed, which invites someone to close it twice or to trust it is still open.
 */
export function normalizeOrderInstructions(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  return text.slice(0, MAX_INSTRUCTIONS_LENGTH)
}
