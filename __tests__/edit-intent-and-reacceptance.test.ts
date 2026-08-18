/**
 * The editor's two pure halves: desired-quantity derivation (H step 1) and the re-acceptance
 * predicate (H step 2).
 *
 * Every assertion here is a row of the ruling. Where the ruling gives an expected outcome, both
 * sides are asserted -- the case that must fire AND the case that must not -- because a predicate
 * that always returns true passes half of any table.
 */
import {
  deriveEditIntent,
  desiredFromStored,
  InvalidDesiredQuantityError,
  type DesiredItem,
} from '@/lib/orders/derive-edit-intent'
import { introducedContent, decideReacceptance } from '@/lib/orders/reacceptance'
import { capIdentity, reacceptanceIdentity } from '@/lib/orders/logical-item-identity'

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

/** The editor's row for an item, at the quantity the customer now wants. */
const want = (sample: Record<string, unknown>, quantity: number): DesiredItem => ({
  identity: capIdentity(sample),
  quantity,
  sample,
})

// ============================================================================================
// STEP 1 — desired quantities, never button history
// ============================================================================================

describe('deriveEditIntent — the four sequences of section 3', () => {
  const stored = [line({ quantity: 2 })]

  it('2 -> 4 -> 1 keeps 1 and adds NOTHING', () => {
    // The naive "replay the presses" implementation adds 2 then removes 3. This must not.
    const intent = deriveEditIntent(stored, [want(line(), 1)])
    expect(intent.keep).toEqual([{ index: 0, quantity: 1 }])
    expect(intent.add).toEqual([])
  })

  it('2 -> 1 -> 2 is a NO-OP: nothing kept away, nothing added', () => {
    const intent = deriveEditIntent(stored, [want(line(), 2)])
    expect(intent.keep).toEqual([{ index: 0, quantity: 2 }])
    expect(intent.add).toEqual([])
    expect(intent.unchanged).toBe(true)
  })

  it('2 -> 0 -> 2 is also a no-op — emptying and refilling adds nothing', () => {
    const intent = deriveEditIntent(stored, [want(line(), 2)])
    expect(intent.add).toEqual([])
    expect(intent.unchanged).toBe(true)
  })

  it('0 -> 3 on an item the order does not hold is all addition', () => {
    const fresh = line({ menuItemId: 'fries', name: 'Fries' })
    const intent = deriveEditIntent(stored, [want(line(), 2), want(fresh, 3)])
    expect(intent.add).toHaveLength(1)
    expect(intent.add[0].quantity).toBe(3)
    expect(intent.add[0].identity).toBe(capIdentity(fresh))
  })

  it('a RISE above the stored quantity goes through add[], never through keep[]', () => {
    // keep[] cannot raise -- repriceKeptLines throws on it -- so a raise expressed as keep would
    // be refused by the server. This is the assertion that keeps the two halves separate.
    const intent = deriveEditIntent(stored, [want(line(), 5)])
    expect(intent.keep).toEqual([{ index: 0, quantity: 2 }])
    expect(intent.add).toEqual([expect.objectContaining({ quantity: 3 })])
    for (const k of intent.keep) expect(k.quantity).toBeLessThanOrEqual(2)
  })

  it('quantity 0 removes the line: it is absent from keep, not present with 0', () => {
    const intent = deriveEditIntent(stored, [want(line(), 0)])
    expect(intent.keep).toEqual([])
    expect(intent.unchanged).toBe(false)
  })

  it('reports `reduced` so the caller does not re-derive it by comparing keep to the order', () => {
    // The panel sends `keep` only when this is true. A second implementation of the question in a
    // component is how the two halves drift, so it is answered once, here.
    expect(deriveEditIntent(stored, [want(line(), 1)]).reduced).toBe(true)
    expect(deriveEditIntent(stored, [want(line(), 0)]).reduced).toBe(true)
    expect(deriveEditIntent(stored, [want(line(), 2)]).reduced).toBe(false)
    // A pure ADDITION is not a reduction — `keep` must stay unsent, or the reduction path
    // repriced an order nobody reduced.
    expect(deriveEditIntent(stored, [want(line(), 5)]).reduced).toBe(false)
  })
})

describe('deriveEditIntent — lots', () => {
  const twoLots = [line({ quantity: 2, unitPrice: 88 }), line({ quantity: 1, unitPrice: 70 })]

  it('treats every lot of one logical item as ONE number, whatever the price', () => {
    expect(desiredFromStored(twoLots)).toEqual([expect.objectContaining({ quantity: 3 })])
  })

  it('fills keep oldest lot first, so a reduction drops the NEWEST lot', () => {
    // 3 -> 2. The just-added lot goes; the older one survives at its own price.
    const intent = deriveEditIntent(twoLots, [want(line(), 2)])
    expect(intent.keep).toEqual([{ index: 0, quantity: 2 }])
  })

  it('spills across lots when the allowance exceeds the first', () => {
    const intent = deriveEditIntent(twoLots, [want(line(), 3)])
    expect(intent.keep).toEqual([
      { index: 0, quantity: 2 },
      { index: 1, quantity: 1 },
    ])
  })

  it('adds beyond the SUM of the lots, not beyond one of them', () => {
    // The lot-blind bug: 4 desired against lots of 2+1 must add 1, not 2.
    const intent = deriveEditIntent(twoLots, [want(line(), 4)])
    expect(intent.add).toEqual([expect.objectContaining({ quantity: 1 })])
  })
})

describe('deriveEditIntent — what it refuses to guess', () => {
  it('leaves a stored item the caller never mentioned UNTOUCHED', () => {
    // Omission must not mean deletion, or a client that failed to enumerate a row would silently
    // cancel food the customer is about to be served.
    const stored = [line({ quantity: 2 }), line({ menuItemId: 'fries', quantity: 1 })]
    const intent = deriveEditIntent(stored, [want(line(), 2)])
    expect(intent.keep).toEqual([
      { index: 0, quantity: 2 },
      { index: 1, quantity: 1 },
    ])
    expect(intent.unchanged).toBe(true)
  })

  it('throws on a fractional, negative or duplicated row rather than coercing it', () => {
    const stored = [line({ quantity: 2 })]
    expect(() => deriveEditIntent(stored, [want(line(), 1.5)])).toThrow(InvalidDesiredQuantityError)
    expect(() => deriveEditIntent(stored, [want(line(), -1)])).toThrow(InvalidDesiredQuantityError)
    expect(() => deriveEditIntent(stored, [want(line(), 1), want(line(), 2)])).toThrow(
      InvalidDesiredQuantityError,
    )
  })
})

// ============================================================================================
// STEP 2 — re-acceptance: the total rose, OR the kitchen was asked for something new
// ============================================================================================

describe('reacceptanceIdentity — the one field that separates it from the cap', () => {
  it('IGNORES the note, where the cap identity distinguishes it', () => {
    const a = line({ specialInstructions: '' })
    const b = line({ specialInstructions: 'no onions' })
    expect(reacceptanceIdentity(a)).toBe(reacceptanceIdentity(b)) // this ruling
    expect(capIdentity(a)).not.toBe(capIdentity(b)) // #307's, unchanged
  })

  it('still distinguishes everything else the customer chose', () => {
    const base = line()
    expect(reacceptanceIdentity(base)).not.toBe(reacceptanceIdentity(line({ size: 'Large' })))
    expect(reacceptanceIdentity(base)).not.toBe(
      reacceptanceIdentity(line({ addons: [{ name: 'Bacon' }] })),
    )
    expect(reacceptanceIdentity(base)).not.toBe(
      reacceptanceIdentity(line({ selectedVariants: { spice: 'hot' } })),
    )
    expect(reacceptanceIdentity(base)).not.toBe(reacceptanceIdentity(line({ menuItemId: 'fries' })))
  })

  it('shares the cap identity’s sorting and trimming, so the two cannot drift', () => {
    expect(reacceptanceIdentity(line({ addons: [{ name: 'oat' }, { name: 'shot' }] }))).toBe(
      reacceptanceIdentity(line({ addons: [{ name: 'shot' }, { name: 'oat' }] })),
    )
    expect(reacceptanceIdentity(line({ size: ' Large ' }))).toBe(
      reacceptanceIdentity(line({ size: 'Large' })),
    )
  })
})

describe('introducedContent — THE TWO-SIDED PAIR THIS RULING TURNS ON', () => {
  it('a NOTE-ONLY edit does NOT re-accept', () => {
    const accepted = [line({ specialInstructions: '' })]
    const proposed = [line({ specialInstructions: 'no onions' })]
    expect(introducedContent(accepted, proposed)).toBe(false)
  })

  it('a Burger+Cheese -> Burger+Bacon SWAP DOES re-accept', () => {
    const accepted = [line({ menuItemId: 'burger', addons: [{ name: 'Cheese' }] })]
    const proposed = [line({ menuItemId: 'burger', addons: [{ name: 'Bacon' }] })]
    expect(introducedContent(accepted, proposed)).toBe(true)
  })
})

describe('introducedContent — every row of the ruling’s table', () => {
  const wings = (over = {}) => line({ menuItemId: 'wings', name: 'Wings', ...over })

  it('A: 3 wings where 2 were accepted — re-accept', () => {
    expect(introducedContent([wings({ quantity: 2 })], [wings({ quantity: 3 })])).toBe(true)
  })

  it('B: 2 wings where 3 were accepted — NO re-accept', () => {
    expect(introducedContent([wings({ quantity: 3 })], [wings({ quantity: 2 })])).toBe(false)
  })

  it('C: an item with no accepted counterpart appears — re-accept', () => {
    expect(
      introducedContent([wings({ quantity: 2 })], [wings({ quantity: 2 }), line({ menuItemId: 'fries' })]),
    ).toBe(true)
  })

  it('D: Beef swapped for Chicken — re-accept', () => {
    expect(introducedContent([line({ menuItemId: 'beef' })], [line({ menuItemId: 'chicken' })])).toBe(
      true,
    )
  })

  it('E: a line removed entirely — NO re-accept', () => {
    expect(introducedContent([wings(), line({ menuItemId: 'fries' })], [wings()])).toBe(false)
  })

  it('G: + then - back to the original — NO re-accept, because the RESULT is compared', () => {
    // A predicate that read the edit's add[] would fire here. This one reads the resulting lines.
    expect(introducedContent([wings({ quantity: 2 })], [wings({ quantity: 2 })])).toBe(false)
  })

  it('FAILS CLOSED on a line with no product id, rather than collapsing two items into one key', () => {
    // Unreachable today (calculateOrderPricing refuses such a line) but the failure mode is a
    // SILENT swap, so the guard is asserted rather than assumed. Both sides checked.
    const anon = { name: 'Mystery', quantity: 1 }
    expect(introducedContent([anon], [anon])).toBe(true)
    expect(introducedContent([anon], [wings()])).toBe(true)
    expect(introducedContent([wings()], [anon])).toBe(true)
    // ...and an identified pair is still judged on content, not blanket-refused.
    expect(introducedContent([wings()], [wings()])).toBe(false)
  })

  it('lots are summed on both sides, so merging or splitting them changes nothing', () => {
    const merged = [wings({ quantity: 3 })]
    const split = [wings({ quantity: 2, unitPrice: 88 }), wings({ quantity: 1, unitPrice: 70 })]
    expect(introducedContent(merged, split)).toBe(false)
    expect(introducedContent(split, merged)).toBe(false)
  })
})

describe('decideReacceptance — the two clauses are OR’d, and neither is dropped', () => {
  const same = [line()]

  it('a RISE with no new content still re-accepts', () => {
    // A price rose under an unchanged quantity. The content clause alone would miss this.
    const d = decideReacceptance({
      previousTotal: 88,
      nextTotal: 99,
      acceptedLines: same,
      proposedLines: same,
    })
    expect(d).toEqual({ required: true, reason: 'total_rose' })
  })

  it('NEW CONTENT at an unchanged total still re-accepts', () => {
    // The equal-price swap: the defect this ruling closes. The total clause alone would miss it.
    const d = decideReacceptance({
      previousTotal: 88,
      nextTotal: 88,
      acceptedLines: [line({ addons: [{ name: 'Cheese' }] })],
      proposedLines: [line({ addons: [{ name: 'Bacon' }] })],
    })
    expect(d).toEqual({ required: true, reason: 'introduced_content' })
  })

  it('NEW CONTENT at a FALLING total still re-accepts', () => {
    const d = decideReacceptance({
      previousTotal: 200,
      nextTotal: 120,
      acceptedLines: [line({ menuItemId: 'steak', quantity: 2 })],
      proposedLines: [line({ menuItemId: 'salad' })],
    })
    expect(d.required).toBe(true)
    expect(d.reason).toBe('introduced_content')
  })

  it('a pure REDUCTION does not re-accept — the 2026-08-16 ruling survives intact', () => {
    const d = decideReacceptance({
      previousTotal: 225,
      nextTotal: 200,
      acceptedLines: [line({ quantity: 3 })],
      proposedLines: [line({ quantity: 2 })],
    })
    expect(d).toEqual({ required: false, reason: 'none' })
  })

  it('a note-only edit does not re-accept even though the note changed', () => {
    const d = decideReacceptance({
      previousTotal: 88,
      nextTotal: 88,
      acceptedLines: [line({ specialInstructions: '' })],
      proposedLines: [line({ specialInstructions: 'extra crispy' })],
    })
    expect(d.required).toBe(false)
  })

  it('reports total_rose in preference when BOTH clauses hold', () => {
    const d = decideReacceptance({
      previousTotal: 88,
      nextTotal: 176,
      acceptedLines: [line()],
      proposedLines: [line(), line({ menuItemId: 'fries' })],
    })
    expect(d.reason).toBe('total_rose')
  })

  it('compares the total in integer cents, not with a float tolerance (#180)', () => {
    const d = decideReacceptance({
      previousTotal: 0.29,
      nextTotal: 0.3,
      acceptedLines: same,
      proposedLines: same,
    })
    expect(d).toEqual({ required: true, reason: 'total_rose' })
  })
})
