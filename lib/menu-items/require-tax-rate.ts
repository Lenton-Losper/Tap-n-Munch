/**
 * A MENU ITEM CANNOT BE SAVED WITHOUT AN EXPLICITLY CHOSEN TAX RATE. Ruled 2026-08-18.
 *
 * ============================================================================================
 * WHY
 * ============================================================================================
 *
 * A paid receipt on production, order #10, 18 Aug 17:01:
 *
 *     1x coffee      NAD  50.00     stored tax 0.00    rate 0%
 *     1x Pork Star   NAD 240.00     stored tax 12.12   rate 5.32%
 *     Subtotal       NAD 277.88
 *     VAT            NAD  12.12     <- at 15% inclusive it should be 37.83
 *     TOTAL          NAD 290.00
 *
 * The arithmetic was faithful: every line's stored tax matched its own stored rate exactly. The
 * `coffee` line carried NO rate at all — `tax_rate_id = null` — so it fell back to the
 * restaurant's default, which on that restaurant is deliberately `no-tax` at 0%.
 *
 * ZERO-RATING BY DEFAULT IS DELIBERATE AND IS NOT CHANGED HERE. What was wrong is that nobody
 * chose it. The menu form's default selection was literally "Use restaurant default", so an item
 * could be created without the question ever being put — and the first anyone learned of it was a
 * VAT figure on a receipt a customer had already paid.
 *
 * WHY A REFUSAL AND NOT A WARNING. A warning that can be ignored is exactly how this happened.
 * Choosing "no tax" deliberately is one click; forgetting is a wrong tax figure on a customer's
 * receipt. Those are not symmetrical, so the save stops.
 *
 * ============================================================================================
 * THE RULE
 * ============================================================================================
 *
 *   CREATE   `tax_rate_id` is required. There is no implicit fallback.
 *   EDIT     the item must not be LEFT without one. Omitting the field keeps whatever is already
 *            there — but if that is null, the save is refused until someone picks. So editing a
 *            legacy item forces the choice, without ever assigning a rate on anyone's behalf.
 *
 * "No tax" remains a perfectly good answer. It just has to be given.
 *
 * ENFORCED SERVER-SIDE. The client check is convenience; the API is authoritative. A disabled
 * button is not a rule — this project has shipped that mistake before (a client guard is not a
 * lock, #302), and the menu API is reachable without the form.
 *
 * NOTHING IS MIGRATED. Existing rows with a null rate are untouched: assigning one changes what a
 * customer is charged, and which of them become Standard, an explicit zero, or retired is the
 * owner's decision. The pricing fallback in lib/tax-rates/apply-tax.ts is therefore LEFT ALONE —
 * removing it would silently reprice every legacy item.
 */

/**
 * The refusal shown when a menu item is saved with no tax rate chosen. SIGNED OFF 2026-08-18,
 * wording the human's, verbatim.
 *
 * Staff-facing, and it renders in two places that must not disagree: the form's validation toast
 * and the API's error body, which is why it is one exported constant rather than a string at each
 * site. It is an instruction, not an explanation -- the person is mid-save and needs the next
 * action, not the reason.
 */
export const TAX_RATE_REQUIRED_MESSAGE = 'Choose a tax rate before saving this item.'

export type TaxRateRefusal = { ok: false; message: string; field: 'tax_rate_id' }
export type TaxRateOk = { ok: true }

const present = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * Is the tax rate on this save acceptable?
 *
 * @param incoming  the value the caller sent. `undefined` means "not part of this request".
 * @param existing  the value already on the row, for an EDIT. `null` for a CREATE.
 *
 * Empty string and null are treated identically: the form sends `''` for "not chosen" and the
 * column holds `null`, and both mean the same thing to a person looking at a receipt.
 */
export function checkTaxRateChosen(
  incoming: unknown,
  existing: string | null = null,
): TaxRateOk | TaxRateRefusal {
  // Explicitly set to something real: fine, whatever it is — including a 0% rate.
  if (present(incoming)) return { ok: true }

  // Explicitly cleared. Never allowed: this is the state the ruling exists to remove.
  if (incoming !== undefined) {
    return { ok: false, message: TAX_RATE_REQUIRED_MESSAGE, field: 'tax_rate_id' }
  }

  // Not part of the request. Whatever is on the row stands — unless the row has none either, in
  // which case this save would LEAVE it unset, which is the thing being refused.
  if (present(existing)) return { ok: true }
  return { ok: false, message: TAX_RATE_REQUIRED_MESSAGE, field: 'tax_rate_id' }
}

/**
 * Does the chosen rate belong to the restaurant being edited?
 *
 * Checked alongside the presence rule because "a rate was chosen" and "a rate this restaurant
 * owns" are different questions, and the API is reachable without the form. A rate id from another
 * tenant would otherwise be accepted and then silently fall back at pricing time, which is the
 * same silence by another route.
 */
export function taxRateBelongsToRestaurant(
  rateId: unknown,
  restaurantRateIds: readonly string[],
): boolean {
  if (!present(rateId)) return false
  return restaurantRateIds.includes(String(rateId).trim())
}
