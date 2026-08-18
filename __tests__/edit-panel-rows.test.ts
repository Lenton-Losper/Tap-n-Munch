/**
 * The edit panel's row model — the load-bearing half of the 2026-08-18 rewrite.
 *
 * These rules used to live inside components/order-edit-panel.tsx, where the only available proof
 * was "it compiles": there is no React testing library in this project. They were extracted so
 * every one of them can be asserted, and so the component keeps only JSX and the lock lifecycle.
 */
import {
  mergePicks,
  pendingAdditionsFor,
  restoredQuantity,
  rowCanBeAddedTo,
  safeDeriveEditIntent,
  setRowQuantity,
  toWorkingRows,
} from '@/lib/orders/edit-panel-rows'
import { capIdentity } from '@/lib/orders/logical-item-identity'

const line = (over: Record<string, unknown> = {}) => ({
  menuItemId: 'wrap',
  name: 'Chicken Wrap',
  size: null,
  addons: [],
  selectedVariants: {},
  specialInstructions: '',
  quantity: 1,
  unitPrice: 88,
  subtotal: 76.5,
  tax: 11.5,
  total: 88,
  ...over,
})

describe('toWorkingRows — one row per logical item, not per stored lot', () => {
  it('collapses several lots of one item into ONE row at the summed quantity', () => {
    // Three steppers for one item is the #297/#299 complaint. This is the assertion that stops it.
    const rows = toWorkingRows([line({ quantity: 2 }), line({ quantity: 1, unitPrice: 70 })])
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(3)
    expect(rows[0].originalQuantity).toBe(3)
  })

  it('keeps genuinely different configurations apart', () => {
    const rows = toWorkingRows([line(), line({ size: 'Large' }), line({ menuItemId: 'fries' })])
    expect(rows).toHaveLength(3)
  })

  it('survives a missing or malformed items value rather than throwing on render', () => {
    expect(toWorkingRows(null)).toEqual([])
    expect(toWorkingRows('nonsense')).toEqual([])
  })
})

describe('mergePicks — a pick raises the matching row instead of appearing beside it', () => {
  it('folds a pick of an item already on the order into that row', () => {
    const rows = toWorkingRows([line({ quantity: 2 })])
    const merged = mergePicks(rows, [line({ quantity: 1 })])
    expect(merged).toHaveLength(1)
    expect(merged[0].quantity).toBe(3) // and NOT two rows showing 2 and 1
  })

  it('adds a genuinely new pick as its own row with no original', () => {
    const merged = mergePicks(toWorkingRows([line({ quantity: 2 })]), [
      line({ menuItemId: 'fries', name: 'Fries', quantity: 2 }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[1].originalQuantity).toBe(0)
    expect(merged[1].quantity).toBe(2)
  })

  it('does NOT mutate the rows it was handed — they are React state', () => {
    const rows = toWorkingRows([line({ quantity: 2 })])
    mergePicks(rows, [line({ quantity: 1 })])
    expect(rows[0].quantity).toBe(2)
  })

  it('defaults a pick with no usable quantity to one, rather than to NaN', () => {
    expect(mergePicks([], [line({ quantity: undefined })])[0].quantity).toBe(1)
    expect(mergePicks([], [line({ quantity: 'x' })])[0].quantity).toBe(1)
  })
})

describe('the stepper', () => {
  const rows = toWorkingRows([line({ quantity: 3 })])
  const id = capIdentity(line())

  it('never goes below zero', () => {
    expect(setRowQuantity(rows, id, -5)[0].quantity).toBe(0)
  })

  it('leaves other rows alone', () => {
    const two = toWorkingRows([line({ quantity: 3 }), line({ menuItemId: 'fries', quantity: 1 })])
    expect(setRowQuantity(two, id, 1)[1].quantity).toBe(1)
  })

  it('restores a removed row to the ORIGINAL quantity, not to 1', () => {
    // Undoing a removal must undo the removal. Restoring a 3 as a 1 is a silent reduction.
    expect(restoredQuantity({ ...rows[0], quantity: 0 })).toBe(3)
  })

  it('restores a PICKED row to one, because it has no original to go back to', () => {
    expect(restoredQuantity({ ...rows[0], quantity: 0, originalQuantity: 0 })).toBe(1)
  })

  it('offers the raise control only where a menu item id makes live pricing possible', () => {
    expect(rowCanBeAddedTo(rows[0])).toBe(true)
    expect(rowCanBeAddedTo({ ...rows[0], raw: { name: 'Legacy' } })).toBe(false)
  })
})

describe('safeDeriveEditIntent — a corrupt store must not blank the screen', () => {
  it('returns an inert intent instead of throwing', () => {
    // deriveEditIntent throws on a fractional row; this runs during render, where a throw is a
    // white screen. Refusing to enable Save is a customer who can still read their order.
    const bad = [{ identity: 'x', quantity: 1.5, originalQuantity: 0, name: 'X', raw: {} }]
    expect(safeDeriveEditIntent([], bad)).toEqual({
      keep: [],
      add: [],
      reduced: false,
      unchanged: true,
    })
  })

  it('still derives normally for well-formed rows — the guard is not swallowing everything', () => {
    // The positive control. Without it the test above passes for a function that always returns
    // the inert value.
    const stored = [line({ quantity: 2 })]
    const rows = setRowQuantity(toWorkingRows(stored), capIdentity(line()), 5)
    const intent = safeDeriveEditIntent(stored, rows)
    expect(intent.keep).toEqual([{ index: 0, quantity: 2 }])
    expect(intent.add).toEqual([expect.objectContaining({ quantity: 3 })])
    expect(intent.reduced).toBe(false)
  })
})

describe('the picker transport', () => {
  it('carries exactly what Save would send as additions', () => {
    // Store and wire form come from the SAME value, so a round trip through the menu cannot
    // produce an edit different from the one the screen showed before leaving.
    const stored = [line({ quantity: 2 })]
    const rows = setRowQuantity(toWorkingRows(stored), capIdentity(line()), 4)
    const intent = safeDeriveEditIntent(stored, rows)
    const carried = pendingAdditionsFor(intent)
    expect(carried).toHaveLength(1)
    expect(carried[0].quantity).toBe(2)
    expect(carried[0].menuItemId).toBe('wrap')
  })

  it('is IDEMPOTENT: re-absorbing what it wrote reproduces the same rows', () => {
    // The bug this shape prevents: seed rows from stored + store, write the store back from those
    // rows, re-acquire the lock, and the picks must not be counted twice.
    const stored = [line({ quantity: 2 })]
    const first = mergePicks(toWorkingRows(stored), [line({ quantity: 2 })])
    const carried = pendingAdditionsFor(safeDeriveEditIntent(stored, first))
    const second = mergePicks(toWorkingRows(stored), carried)
    expect(second.map((r) => r.quantity)).toEqual(first.map((r) => r.quantity))
  })

  it('carries nothing when the edit is a pure reduction', () => {
    const stored = [line({ quantity: 3 })]
    const rows = setRowQuantity(toWorkingRows(stored), capIdentity(line()), 1)
    expect(pendingAdditionsFor(safeDeriveEditIntent(stored, rows))).toEqual([])
  })
})

describe('section 3 — the four sequences, end to end through the row model', () => {
  const stored = [line({ quantity: 2 })]
  const id = capIdentity(line())
  const after = (finalQuantity: number) =>
    safeDeriveEditIntent(stored, setRowQuantity(toWorkingRows(stored), id, finalQuantity))

  it('2 to 4 to 1 keeps 1 and adds nothing', () => {
    expect(after(1)).toMatchObject({ keep: [{ index: 0, quantity: 1 }], add: [] })
  })

  it('2 to 1 to 2 changes nothing at all', () => {
    expect(after(2).unchanged).toBe(true)
  })

  it('2 to 0 to 2 changes nothing at all', () => {
    expect(after(2).unchanged).toBe(true)
  })

  it('2 to 3 adds exactly one, through the guarded path', () => {
    expect(after(3).add).toEqual([expect.objectContaining({ quantity: 1 })])
    expect(after(3).reduced).toBe(false)
  })
})
