import { capIdentity, lineQuantity, type ComparableLine } from './logical-item-identity'

/**
 * THE EDITOR SPEAKS IN DESIRED QUANTITIES. The wire speaks in keep and add. This translates.
 *
 * WHY THIS EXISTS. The edit API has two halves that behave differently on purpose: `keep[]` can
 * only REDUCE a stored lot (`repriceKeptLines` throws on any raise), and `add[]` is the guarded
 * path that runs stock, cap and payment-method checks. A UI that drove those two directly would
 * have to remember which button the customer pressed, and every ruling in section 3 is a case
 * where button history gives the wrong answer:
 *
 *     2 -> 4 -> 1     pressed + twice then - three times. Result: 1. NOT "added 2, removed 3".
 *     2 -> 1 -> 2     pressed - then +. Result: 2, and NOTHING was added.
 *     2 -> 0 -> 2     the line was emptied and refilled. Result: 2, still nothing added.
 *     0 -> 3          a new item. Result: 3, all of it an addition.
 *
 * So the editor holds ONE number per logical item -- what the customer wants to end up with -- and
 * this derives the wire form from it at Save. Press history is never read. That is not an
 * optimisation; it is the only way the four sequences above can share one implementation.
 *
 *     keep     = min(original, desired)      expressed against the STORED lot indices
 *     addition = max(0, desired - original)
 *
 * `original` is summed across EVERY stored lot of the same `capIdentity`, so an item that arrived
 * in three separate additions is one number to the customer and one number here.
 *
 * WHICH LOT A REDUCTION REMOVES. Keep is filled in stored order, oldest lot first, so a reduction
 * drops the NEWEST lots. That makes "I just added one, undo it" remove the thing that was just
 * added rather than something the customer has not touched. It is also fully deterministic, which
 * matters more than any cleverness: when two lots of the same item were charged different prices,
 * a customer reducing from 2 to 1 keeps the older lot at its own price. Nothing here averages,
 * invents or re-derives a price -- this module produces instructions only, and the server prices
 * the result.
 *
 * NOTHING HERE WRITES, FETCHES OR PRICES. It is a pure function of (stored lines, desired
 * quantities) so that every sequence in section 3 and every row of the section 25 matrix can be
 * asserted without a database.
 */

/** What `repriceKeptLines` consumes: a stored lot index and the quantity to keep from it. */
export type LineKeepInstruction = { index: number; quantity: number }

/**
 * One row of the editor's state. `sample` supplies the configuration when the row turns out to
 * need an addition -- it is the only way a brand-new item (no stored lot at all) can describe
 * itself.
 */
export type DesiredItem = {
  /** `capIdentity` of the logical item. Callers must not invent their own key -- see that module. */
  identity: string
  /** Whole number, 0 or more. 0 means the customer removed the item entirely. */
  quantity: number
  /** A line carrying this item's configuration. For a stored item, any of its lots will do. */
  sample: ComparableLine
}

export type EditAddition = {
  identity: string
  /** Whole number, 1 or more. Rows needing no addition are absent, not present with 0. */
  quantity: number
  sample: ComparableLine
}

export type EditIntent = {
  keep: LineKeepInstruction[]
  add: EditAddition[]
  /**
   * True when nothing about the order changed -- no reduction, no removal, no addition. Save
   * should be inert rather than taking a lock and writing an identical order.
   */
  unchanged: boolean
}

export class InvalidDesiredQuantityError extends Error {}

const whole = (v: unknown): number => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

/**
 * The editor's opening state: every stored line, at the quantity it currently holds.
 *
 * Lots of the same logical item collapse into ONE row, because that is what the customer sees
 * after #307's aggregation and a stepper that moved a lot rather than an item would be a different
 * number from the one printed above it.
 */
export function desiredFromStored(storedItems: unknown): DesiredItem[] {
  const lines = (Array.isArray(storedItems) ? storedItems : []) as ComparableLine[]
  const rows = new Map<string, DesiredItem>()
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const identity = capIdentity(line)
    const existing = rows.get(identity)
    if (existing) existing.quantity += lineQuantity(line)
    else rows.set(identity, { identity, quantity: lineQuantity(line), sample: line })
  }
  return [...rows.values()]
}

/**
 * Translate desired quantities into the wire form.
 *
 * @throws InvalidDesiredQuantityError on a non-whole or negative quantity, or a duplicated
 * identity. These are programming errors in the caller, not customer input -- a stepper cannot
 * produce them -- so they fail loudly rather than being coerced into something plausible.
 */
export function deriveEditIntent(
  storedItems: unknown,
  desired: readonly DesiredItem[],
): EditIntent {
  const lines = (Array.isArray(storedItems) ? storedItems : []) as ComparableLine[]
  const rows = Array.isArray(desired) ? desired : []

  const wanted = new Map<string, DesiredItem>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new InvalidDesiredQuantityError('Each desired row must be an object')
    }
    const quantity = whole(row.quantity)
    if (!Number.isFinite(quantity)) {
      throw new InvalidDesiredQuantityError(
        `Desired quantity for ${row.identity} must be a whole number of 0 or more`,
      )
    }
    if (wanted.has(row.identity)) {
      throw new InvalidDesiredQuantityError(
        `Identity ${row.identity} appears twice; lots of one logical item are ONE row`,
      )
    }
    wanted.set(row.identity, { ...row, quantity })
  }

  /**
   * A stored item the caller did not mention is UNTOUCHED, not removed. Omission cannot mean
   * deletion here: the editor sends the rows it is showing, and a row scrolled out of view or a
   * client that failed to enumerate one lot would otherwise silently delete food the customer is
   * about to be served. Removal is explicit -- quantity 0.
   */
  const originals = new Map<string, number>()
  for (const row of desiredFromStored(lines)) originals.set(row.identity, row.quantity)

  const remaining = new Map<string, number>()
  for (const [identity, stored] of originals) {
    remaining.set(identity, wanted.has(identity) ? wanted.get(identity)!.quantity : stored)
  }

  // KEEP. Walk the stored lots in order and fill each item's allowance oldest lot first.
  const keep: LineKeepInstruction[] = []
  let reduced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || typeof line !== 'object') continue
    const identity = capIdentity(line)
    const stored = lineQuantity(line)
    const allowance = remaining.get(identity) ?? 0
    const take = Math.min(stored, allowance)
    remaining.set(identity, allowance - take)
    if (take > 0) keep.push({ index, quantity: take })
    if (take < stored) reduced = true
  }

  // ADD. Whatever the desired quantity asks for beyond what the order already holds.
  const add: EditAddition[] = []
  for (const row of wanted.values()) {
    const extra = row.quantity - (originals.get(row.identity) ?? 0)
    if (extra > 0) add.push({ identity: row.identity, quantity: extra, sample: row.sample })
  }

  return { keep, add, unchanged: !reduced && add.length === 0 }
}
