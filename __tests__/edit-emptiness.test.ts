/**
 * #291 -- an edit is empty only when kept lines AND pending additions are both zero.
 *
 * The live defect was that SWAPPING AN ITEM WAS IMPOSSIBLE: remove the only line, add another,
 * and both the panel and the route read "zero kept" as "empty order" and refused. The swap is a
 * capability the section-22 overrule was written to allow, and it could not be performed at all.
 *
 * The `swap` case below is the one this file exists for. The rest guard the edges around it.
 */
import { editLeavesOrderEmpty } from '@/lib/orders/edit-emptiness'

describe('#291 editLeavesOrderEmpty', () => {
  it('SWAP: zero kept with one addition is NOT empty', () => {
    // The exact click-test repro: remove the only Chicken burger, add a Chicken Wrap.
    expect(editLeavesOrderEmpty({ keptLineCount: 0, additionCount: 1 })).toBe(false)
  })

  it('zero and zero IS empty', () => {
    expect(editLeavesOrderEmpty({ keptLineCount: 0, additionCount: 0 })).toBe(true)
  })

  it('a surviving line alone is not empty', () => {
    expect(editLeavesOrderEmpty({ keptLineCount: 1, additionCount: 0 })).toBe(false)
  })

  it('both present is not empty', () => {
    expect(editLeavesOrderEmpty({ keptLineCount: 2, additionCount: 3 })).toBe(false)
  })

  it('a many-line swap is not empty', () => {
    expect(editLeavesOrderEmpty({ keptLineCount: 0, additionCount: 4 })).toBe(false)
  })

  it('nonsense counts are treated as zero, never as content', () => {
    // A bad count must not be able to make an empty order look populated -- that would commit an
    // order with no lines, which is the thing the guard exists to prevent.
    for (const bad of [NaN, -1, -99, Infinity * 0]) {
      expect(editLeavesOrderEmpty({ keptLineCount: bad, additionCount: bad })).toBe(true)
    }
  })

  it('Infinity is nonsense, so it refuses rather than trusting it', () => {
    // I first wrote this expecting `false` -- "Infinity is not zero, so there is content". That
    // is the wrong direction to fail. Returning true REFUSES the edit; returning false would
    // commit an order whose line count could not be trusted. A count nothing can produce
    // legitimately should stop the edit, not wave it through.
    expect(editLeavesOrderEmpty({ keptLineCount: 0, additionCount: Infinity })).toBe(true)
  })

  it('fractional counts floor rather than round up', () => {
    // 0.5 of a line is not a line. Rounding up would let a malformed count defeat the guard.
    expect(editLeavesOrderEmpty({ keptLineCount: 0.5, additionCount: 0.5 })).toBe(true)
  })
})
