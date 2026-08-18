import {
  deriveEditIntent,
  desiredFromStored,
  type EditIntent,
} from './derive-edit-intent'
import { capIdentity } from './logical-item-identity'

/**
 * The editor's row model: everything about the edit panel that is a function of its inputs.
 *
 * EXTRACTED FROM THE COMPONENT 2026-08-18, when the panel moved from press-accumulation to desired
 * quantities. The rewrite is the load-bearing half of that change, and inside a `.tsx` with no
 * React testing library installed the only available proof was "it compiles". Out here every rule
 * below is assertable, and the component keeps just the JSX and the lock lifecycle.
 */

/**
 * ONE ROW PER LOGICAL ITEM, HOLDING ONE NUMBER: what the customer wants to END UP WITH.
 *
 * The panel used to hold one row per STORED LINE INDEX, with `-` decrementing a working quantity
 * while `+` appended to a separate additions list. Two lists meant the saved result was a function
 * of which buttons were pressed, and section 3 of the ruling is four cases where press history
 * gives the wrong answer. The worst was measurable on the deployed screen: from a stored 2, press
 * `+` twice and `-` three times, and the customer sees 1 while the order commits 2.
 *
 * ROWS ARE LOGICAL ITEMS, NOT LOTS, for the same reason My Orders aggregates them (#307): an item
 * that arrived in three additions is one thing to the customer, and three steppers for one item is
 * the #297/#299 complaint wearing a different hat.
 */
export type WorkingRow = {
  /** `capIdentity`. The domain's key -- this module must not invent its own. */
  identity: string
  /** The desired quantity. 0 means removed; the row still renders so it can be restored. */
  quantity: number
  /** What the order holds now, summed across every lot. 0 for something picked from the menu. */
  originalQuantity: number
  name: string
  /**
   * A stored (or picked) line, so the row can show what was CONFIGURED (#298) and so an addition
   * can describe itself.
   *
   * Not flattened: `lineConfigurationSummary` owns reading the two possible shapes, and a second
   * copy of that logic is exactly the drift #295 spent a sweep undoing.
   */
  raw: Record<string, unknown>
}

export function rowName(item: Record<string, unknown>): string {
  return String(item?.displayName ?? item?.name ?? 'Item')
}

/** The editor's opening state: the order as it stands, one row per logical item. */
export function toWorkingRows(items: unknown): WorkingRow[] {
  return desiredFromStored(items).map((row) => ({
    identity: row.identity,
    quantity: row.quantity,
    originalQuantity: row.quantity,
    name: rowName(row.sample as Record<string, unknown>),
    raw: row.sample as Record<string, unknown>,
  }))
}

/**
 * Fold the menu picks into the rows.
 *
 * A pick whose configuration matches something already on the order RAISES that row rather than
 * appearing beside it -- otherwise the customer sees "2x Wrap" and "+ Wrap" as two separate things
 * and has no single number to reason about, which is the state the rewrite removes.
 *
 * Pure: the input rows are not mutated, because they are React state.
 */
export function mergePicks(rows: WorkingRow[], picks: unknown): WorkingRow[] {
  const merged = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }))
  for (const pick of (Array.isArray(picks) ? picks : []) as Array<Record<string, unknown>>) {
    if (!pick || typeof pick !== 'object') continue
    const identity = capIdentity(pick)
    const raw = Number(pick.quantity)
    const quantity = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
    const existing = merged.find((row) => row.identity === identity)
    if (existing) existing.quantity += quantity
    else merged.push({ identity, quantity, originalQuantity: 0, name: rowName(pick), raw: pick })
  }
  return merged
}

/** Set one row's desired quantity. Never negative; 0 is removal, which is a legal end state here. */
export function setRowQuantity(rows: WorkingRow[], identity: string, next: number): WorkingRow[] {
  return rows.map((row) =>
    row.identity === identity ? { ...row, quantity: Math.max(0, Math.floor(next)) } : row,
  )
}

/**
 * Restore a removed row to what the ORDER holds, not to 1 -- undoing a removal must undo the
 * removal, not silently reduce a 3 to a 1. A picked row has no original, so it restores to one.
 */
export function restoredQuantity(row: WorkingRow): number {
  return row.originalQuantity > 0 ? row.originalQuantity : 1
}

/** No menu item id, no live pricing, so no `+` control -- the server would refuse the raise. */
export function rowCanBeAddedTo(row: WorkingRow): boolean {
  return Boolean(String(row?.raw?.menuItemId ?? row?.raw?.menu_item_id ?? '').trim())
}

/**
 * `deriveEditIntent`, guarded.
 *
 * It THROWS on a fractional or duplicated row, and the panel calls this during render. A stepper
 * cannot produce either -- but the rows are seeded from sessionStorage, the one input a previous
 * version of the app, or a hand-edited value, could have written. An exception during render is a
 * blank screen; refusing to enable Save is a customer who can still read their order.
 */
export function safeDeriveEditIntent(storedItems: unknown, rows: WorkingRow[]): EditIntent {
  try {
    return deriveEditIntent(
      Array.isArray(storedItems) ? (storedItems as Array<Record<string, unknown>>) : [],
      (Array.isArray(rows) ? rows : []).map((row) => ({
        identity: row.identity,
        quantity: row.quantity,
        sample: row.raw,
      })),
    )
  } catch {
    return { keep: [], add: [], reduced: false, unchanged: true }
  }
}

/**
 * What the panel writes to sessionStorage for the picker round trip.
 *
 * The store holds exactly what `intent.add` holds, rewritten whenever the rows move. That makes
 * absorbing it at acquisition IDEMPOTENT: rows are seeded as stored + store, the store is then
 * rewritten to the additions those rows imply, and a second acquisition seeds the same rows again.
 * Clearing the store on absorb instead loses every pick on an ordinary unmount; not clearing it
 * double-counts on re-acquire. Neither is needed if the two are simply kept equal.
 */
export function pendingAdditionsFor(intent: EditIntent): Array<Record<string, unknown>> {
  return intent.add.map((addition) => ({
    ...(addition.sample as Record<string, unknown>),
    quantity: addition.quantity,
  }))
}
