import {
  authoritativeUnitPrice,
  capIdentity,
  displayIdentity,
  lineQuantity,
  type ComparableLine,
} from './logical-item-identity'

/**
 * How an order's lines are shown to a customer AFTER Save, when the same item arrived in several
 * lots.
 *
 * THE PROBLEM. Additions append; they never merge into an existing line. So "one more Pork Star"
 * produces a second row, and a customer sees `Pork Star N$240` twice with no total and no
 * explanation. Two rows that look identical are the #297/#299 complaint, and the per-line addition
 * model guarantees them.
 *
 * THE RULE, ruled 2026-08-17:
 *
 *   1. Aggregate for display only when the SERVER proves item identity, configuration AND
 *      authoritative unit price are identical -- `displayIdentity`.
 *   2. When the authoritative prices differ, group under the product and show each lot separately
 *      with its own figure and a total. NEVER hide the difference.
 *   3. The storage lots are preserved. This is a view; nothing here writes.
 *
 * AGGREGATION SUMS. It never re-derives `quantity × unitPrice`.
 *
 * That is not a style preference and it is enforced structurally: nothing in this file multiplies
 * a price by a quantity, and `AggregatedLine` carries no field that would let a caller do so from
 * the aggregate. If the lots are identical the summed and the computed answer agree -- and the
 * moment they disagree, the summed one is the one the customer was actually charged. A computed
 * figure on a bill is a client-calculated figure on a bill, whatever process computed it.
 *
 * Rounding: money is summed in integer cents and converted once at the end, so summing three lots
 * of 8.333 cannot drift a cent away from what the row totals actually hold.
 */

/** Money is summed in cents; a stored figure may be a float. */
const toCents = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const fromCents = (c: number): number => Math.round(c) / 100

export type AggregatedLine = {
  /** The lots that make up this row, in the order they were stored. Never discarded. */
  lots: ComparableLine[]
  /** Total quantity across the lots. */
  quantity: number
  /**
   * The authoritative unit price shared by every lot in this row, or null when the lots predate
   * pricing. Present for display; nothing here multiplies it.
   */
  unitPrice: number | null
  /** SUMMED from the lots' stored figures. Never `quantity * unitPrice`. */
  subtotal: number
  tax: number
  total: number
}

export type AggregatedGroup = {
  /** Shared cap identity: same product, same configuration, whatever the price. */
  capIdentity: string
  /** A representative lot, for rendering the name and configuration. */
  sample: ComparableLine
  /**
   * One row per distinct authoritative price. Length > 1 is the case ruling 2 governs: the
   * difference is shown, not hidden.
   */
  rows: AggregatedLine[]
  /** Total quantity across every row in the group. */
  quantity: number
  /** SUMMED across the rows. */
  subtotal: number
  tax: number
  total: number
  /** True when the lots disagree about price, so the caller must show the rows separately. */
  hasMixedPrices: boolean
}

/**
 * Group an order's stored lines for display.
 *
 * Group order follows first appearance, and row order within a group follows first appearance, so
 * the screen does not reshuffle when a customer adds to an existing item.
 */
export function aggregateOrderLines(lines: readonly ComparableLine[]): AggregatedGroup[] {
  const source = Array.isArray(lines) ? lines : []
  const groups = new Map<string, AggregatedGroup>()
  const rowIndex = new Map<string, Map<string, AggregatedLine>>()

  for (const line of source) {
    if (!line || typeof line !== 'object') continue
    const cap = capIdentity(line)
    const disp = displayIdentity(line)

    let group = groups.get(cap)
    if (!group) {
      group = {
        capIdentity: cap,
        sample: line,
        rows: [],
        quantity: 0,
        subtotal: 0,
        tax: 0,
        total: 0,
        hasMixedPrices: false,
      }
      groups.set(cap, group)
      rowIndex.set(cap, new Map())
    }

    const rows = rowIndex.get(cap)!
    let row = rows.get(disp)
    if (!row) {
      row = {
        lots: [],
        quantity: 0,
        unitPrice: authoritativeUnitPrice(line),
        subtotal: 0,
        tax: 0,
        total: 0,
      }
      rows.set(disp, row)
      group.rows.push(row)
    }

    // SUM. Not compute. See the file docblock.
    row.lots.push(line)
    row.quantity += lineQuantity(line)
    row.subtotal = fromCents(toCents(row.subtotal) + toCents((line as { subtotal?: unknown }).subtotal))
    row.tax = fromCents(toCents(row.tax) + toCents((line as { tax?: unknown }).tax))
    row.total = fromCents(toCents(row.total) + toCents((line as { total?: unknown }).total))
  }

  for (const group of groups.values()) {
    group.quantity = group.rows.reduce((n, r) => n + r.quantity, 0)
    group.subtotal = fromCents(group.rows.reduce((c, r) => c + toCents(r.subtotal), 0))
    group.tax = fromCents(group.rows.reduce((c, r) => c + toCents(r.tax), 0))
    group.total = fromCents(group.rows.reduce((c, r) => c + toCents(r.total), 0))
    group.hasMixedPrices = group.rows.length > 1
  }

  return [...groups.values()]
}
