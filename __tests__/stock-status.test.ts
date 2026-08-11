import { computeStockStatus, formatSignedStockDelta } from '../lib/stock/format'

describe('formatSignedStockDelta', () => {
  test('formats positive and negative deltas', () => {
    expect(formatSignedStockDelta(5, 'g')).toBe('+5 g')
    expect(formatSignedStockDelta(-15, 'g')).toBe('-15 g')
    expect(formatSignedStockDelta(0, 'g')).toBe('0 g')
  })
})

describe('computeStockStatus', () => {
  test('not tracked when par_level is null', () => {
    expect(computeStockStatus(0, null)).toBe('not_tracked')
    expect(computeStockStatus(100, null)).toBe('not_tracked')
  })

  test('out of stock when currentStock === 0 and par is set', () => {
    expect(computeStockStatus(0, 10)).toBe('out_of_stock')
  })

  // #146. These two assertions previously read `expect(computeStockStatus(-5, null))
  // .toBe('not_tracked')` and `expect(computeStockStatus(-3, 10)).toBe('out_of_stock')` -- a
  // green test pinning the exact defect the issue is about. Both inputs are real: on staging
  // 'whole milk' sits at -8617 with no par level and 'espresso beans' at -154 with one, so the
  // suite asserted that each of the two live impossible balances be reported as ordinary.
  //
  // Kept as one test per branch because the two silent renderings had different causes and a
  // regression would likely revive only one of them.
  test('negative balance is impossible, and says so regardless of par level', () => {
    expect(computeStockStatus(-5, null)).toBe('negative')
    expect(computeStockStatus(-3, 10)).toBe('negative')
    expect(computeStockStatus(-0.0001, null)).toBe('negative')
  })

  test('low stock when 0 < currentStock <= par_level', () => {
    expect(computeStockStatus(5, 10)).toBe('low_stock')
    expect(computeStockStatus(10, 10)).toBe('low_stock')
  })

  test('healthy when currentStock > par_level', () => {
    expect(computeStockStatus(11, 10)).toBe('healthy')
    expect(computeStockStatus(100, 10)).toBe('healthy')
  })
})
