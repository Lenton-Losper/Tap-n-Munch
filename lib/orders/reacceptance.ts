import { editRequiresReacceptance, toCents } from './edit-lock'
import { lineQuantity, reacceptanceIdentity, type ComparableLine } from './logical-item-identity'

/**
 * DOES THIS EDIT GO BACK TO STAFF?
 *
 * RULED 2026-08-18. The question a re-acceptance answers, in plain English:
 *
 *     Re-accept when the total RISES, or when the edited order asks the kitchen to produce
 *     anything it did not previously accept.
 *
 * WHY THE TOTAL ALONE WAS NOT ENOUGH, and this is the whole reason the file exists. Until now the
 * predicate was `nextTotal > previousTotal`. Swap a Burger+Cheese for a Burger+Bacon at the same
 * price and the total does not move -- so the kitchen was told to make a different sandwich and no
 * human ever saw the change. Every equal-price substitution was a silent instruction to staff.
 *
 * THE TWO CLAUSES ARE OR'd, NOT SWAPPED. A rise still re-accepts even when no new content appears
 * (a price could rise under a quantity that did not), and introduced content still re-accepts even
 * when the total falls. Replacing one with the other would reopen the other's hole.
 *
 * ------------------------------------------------------------------------------------------
 * WHICH IDENTITY, AND WHY IT IS NOT THE CAP'S
 * ------------------------------------------------------------------------------------------
 *
 * This compares over `reacceptanceIdentity` -- the cap identity MINUS `specialInstructions`.
 * Ruled 2026-08-18, and the reasoning is that the cap and this ask different questions:
 *
 *     the CAP asks   "how many of this preparation?"  A note makes it a different preparation --
 *                    the kitchen makes them separately -- so it gets its own ceiling. Note IN.
 *     THIS asks      "was the kitchen asked for something NEW?"  Rewording a note on food that was
 *                    already accepted is not new content. Note OUT.
 *
 * The note-only exemption is not a concession invented here; it predates this ruling and survived
 * the 2026-08-16 reversal in both directions. Putting the note in this key would send every
 * "actually, no onions" back for a second Accept, which is exactly what the exemption exists to
 * prevent. Both keys come from one `identityParts` in `logical-item-identity`, so their sorting
 * and trimming cannot drift apart.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A MULTISET DIFFERENCE AND NOT A LIST COMPARISON
 * ------------------------------------------------------------------------------------------
 *
 * "Introduced content" is: some identity whose quantity is HIGHER than it was when staff accepted.
 * Written that way, every case in the ruling's table falls out with no special-casing:
 *
 *     3 wings where 2 were accepted   -> wings 3 > 2                       re-accept
 *     2 wings where 3 were accepted   -> nothing rose                      no
 *     a Bacon burger appears          -> bacon 1 > 0                       re-accept
 *     Beef swapped for Chicken        -> chicken 1 > 0                     re-accept
 *     a line removed entirely         -> nothing rose                      no
 *     the note reworded               -> note is not in the key            no
 *     + then - back to the original   -> compares RESULT, not presses      no
 *
 * The last row is why this takes the proposed lines rather than an edit intent. A predicate that
 * read `add[]` would re-accept an order the customer put back exactly as they found it.
 *
 * NOTHING HERE WRITES OR PRICES. Pure, so the ruling's table is assertable without a database.
 */

/**
 * THE COLLAPSE HAZARD, and why this fails CLOSED.
 *
 * Every part of the identity is a string, so a line carrying no product id at all produces the
 * key for "". Two DIFFERENT such lines would then share one key, their quantities would be summed
 * into one lump, and a swap between them would read as no change -- a silent instruction to the
 * kitchen, which is the exact defect this predicate exists to catch. Fail-open, not fail-safe.
 *
 * It is not reachable today: an editable order is `pending` or `accepted`, so minutes old, and
 * every line on it went through `calculateOrderPricing`, which refuses the whole request with
 * "Each line item needs a valid menuItemId". Legacy lines predating pricing exist only on orders
 * that settled long ago and cannot be edited.
 *
 * Unreachable is a statement about today's callers, not a property of this function, so it is
 * guarded rather than assumed. An unidentified line forces re-acceptance: a human looks at an
 * order we cannot reason about. That over-fires in a case that cannot occur and under-fires in
 * none, which is the correct direction for a gate that protects the kitchen.
 */
function hasUnidentifiedLine(lines: unknown): boolean {
  for (const line of (Array.isArray(lines) ? lines : []) as ComparableLine[]) {
    if (!line || typeof line !== 'object') continue
    if (String(line.menuItemId ?? line.menu_item_id ?? '').trim() === '') return true
  }
  return false
}

function quantityByReacceptanceIdentity(lines: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of (Array.isArray(lines) ? lines : []) as ComparableLine[]) {
    if (!line || typeof line !== 'object') continue
    const key = reacceptanceIdentity(line)
    out.set(key, (out.get(key) ?? 0) + lineQuantity(line))
  }
  return out
}

/**
 * Whether the proposed lines ask for anything the accepted lines did not already cover.
 *
 * Compared as a multiset over `reacceptanceIdentity`. Quantities are summed across lots first, so
 * an item split across three storage lots is one number on both sides -- otherwise merging two
 * lots into one would read as an increase and a split would read as a decrease.
 */
export function introducedContent(acceptedLines: unknown, proposedLines: unknown): boolean {
  // Fail closed on a line we cannot identify. See `hasUnidentifiedLine`.
  if (hasUnidentifiedLine(acceptedLines) || hasUnidentifiedLine(proposedLines)) return true

  const accepted = quantityByReacceptanceIdentity(acceptedLines)
  const proposed = quantityByReacceptanceIdentity(proposedLines)
  for (const [identity, quantity] of proposed) {
    if (quantity > (accepted.get(identity) ?? 0)) return true
  }
  return false
}

export type ReacceptanceInput = {
  previousTotal: number
  nextTotal: number
  /** The lines as staff accepted them -- the order's STORED lines before this edit. */
  acceptedLines: unknown
  /** The lines the order will hold if this edit commits: kept lines plus priced additions. */
  proposedLines: unknown
}

export type ReacceptanceDecision = {
  required: boolean
  /**
   * Which clause fired. Recorded in `edit_history` so a later reader can tell an equal-price swap
   * from a price rise without re-deriving it from two line lists.
   */
  reason: 'total_rose' | 'introduced_content' | 'none'
}

/**
 * THE ONE PLACE the question is answered. Callers must not re-implement either clause.
 *
 * `total_rose` is reported in preference to `introduced_content` when both hold, because a rise is
 * the stronger statement to a staff member: the customer will be charged more.
 */
export function decideReacceptance(input: ReacceptanceInput): ReacceptanceDecision {
  if (editRequiresReacceptance(input.previousTotal, input.nextTotal)) {
    return { required: true, reason: 'total_rose' }
  }
  if (introducedContent(input.acceptedLines, input.proposedLines)) {
    return { required: true, reason: 'introduced_content' }
  }
  return { required: false, reason: 'none' }
}

/** Re-exported so a caller never reaches for a float comparison of its own. See #180. */
export { toCents }
