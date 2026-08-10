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
