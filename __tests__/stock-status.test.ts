import { computeStockStatus } from '../lib/stock/format'

describe('computeStockStatus', () => {
  test('not tracked when par_level is null', () => {
    expect(computeStockStatus(0, null)).toBe('not_tracked')
    expect(computeStockStatus(100, null)).toBe('not_tracked')
    expect(computeStockStatus(-5, null)).toBe('not_tracked')
  })

  test('out of stock when currentStock <= 0 and par is set', () => {
    expect(computeStockStatus(0, 10)).toBe('out_of_stock')
    expect(computeStockStatus(-3, 10)).toBe('out_of_stock')
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
