/**
 * One predicate for "would this edit leave the order with nothing on it?" (#291).
 *
 * An edit has two halves that arrive by different routes. Removals and quantity changes are a
 * REDUCTION of the stored lines, applied by `repriceKeptLines`. Additions are new lines, applied
 * afterwards by `applyEditAdditions`. Emptiness is a property of the RESULT, so it is a question
 * about both halves and belongs to neither of them.
 *
 * It used to live inside `repriceKeptLines`, which threw on an empty `keep`. That was correct
 * when an edit could only ever reduce -- its docblock still says "an edit may never introduce a
 * line" -- and it stopped being correct when spec section 22 was overruled on 2026-08-16 and
 * additions became part of editing. The reduction primitive cannot see the additions, so from
 * inside it every swap looks like an attempt to empty the order.
 *
 * The live cost was that SWAPPING AN ITEM WAS IMPOSSIBLE. Remove the only line, add another, and
 * the panel showed the removal struck through and the addition listed and then refused with
 * "An order needs at least one item", Save greyed out. The one mutation the section-22 ruling was
 * written to allow was the one that could not be performed.
 *
 * So the rule lives here, once, and both sides import it: `order-edit-panel.tsx` for the Save
 * button's disabled state and the warning line, and the edit route before it commits. Fixing only
 * the client would have moved the refusal to a 400 the customer cannot read, because the route
 * carried the same assumption independently.
 *
 * Same shape and the same reason as `canOpenItemSheet` in `lib/menu/item-sheet-availability.ts`:
 * two entry points that each compute their own version of a condition drift apart, and the drift
 * is invisible until someone meets both.
 */

export type EditEmptinessInput = {
  /** Lines that survive the edit -- stored lines not removed, at their (possibly new) quantity. */
  keptLineCount: number
  /** Lines the customer has staged to add but not yet committed. */
  additionCount: number
}

/**
 * True when the edit would commit an order with no lines at all.
 *
 * Deliberately NOT "kept is empty". Zero kept with one addition is a swap, which is a legal edit
 * and the case this function exists for. Negative or non-finite inputs are treated as zero rather
 * than trusted, so a bad count cannot make an empty order look populated.
 */
export function editLeavesOrderEmpty(input: EditEmptinessInput): boolean {
  const kept = safeCount(input.keptLineCount)
  const additions = safeCount(input.additionCount)
  return kept + additions === 0
}

function safeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}
