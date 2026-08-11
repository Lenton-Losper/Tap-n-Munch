import { computeStockStatus } from '../lib/stock/format'
import { findNegativeBalances, type MovementRow } from '../lib/stock/negative-balances'

const mv = (stock_item_id: string, quantity_delta: number | string | null): MovementRow => ({
  stock_item_id,
  quantity_delta,
})

describe('findNegativeBalances', () => {
  test('reports nothing when every balance is zero or positive', () => {
    expect(findNegativeBalances([])).toEqual([])
    expect(findNegativeBalances([mv('a', 10), mv('a', -10), mv('b', 5)])).toEqual([])
  })

  test('reports an item whose movements sum below zero, with its movement count', () => {
    // The shape of the #146 item: every movement a deduction, no receipt ever.
    const movements = [mv('beef-stew', -1), mv('beef-stew', -1), mv('beef-stew', -20)]

    expect(findNegativeBalances(movements)).toEqual([
      { stockItemId: 'beef-stew', balance: -22, movementCount: 3 },
    ])
  })

  test('coerces the string deltas PostgREST returns for numeric columns', () => {
    // quantity_delta is numeric(_,4); over PostgREST it arrives as a string often enough that
    // treating it as a number is the whole difference between detecting and not.
    expect(findNegativeBalances([mv('a', '-8617.0000')])).toEqual([
      { stockItemId: 'a', balance: -8617, movementCount: 1 },
    ])
  })

  test('treats a null delta as zero rather than NaN-ing the whole balance', () => {
    expect(findNegativeBalances([mv('a', null), mv('a', -4)])).toEqual([
      { stockItemId: 'a', balance: -4, movementCount: 2 },
    ])
  })

  test('does not flag an item that cancels to exactly zero in floating point', () => {
    // 0.3 - 0.1 - 0.2 is -2.78e-17, not 0. Without rounding at the stored precision this item
    // -- which holds precisely nothing -- is reported as an impossible balance.
    const movements = [mv('a', 0.3), mv('a', -0.1), mv('a', -0.2)]

    expect(movements.reduce((s, m) => s + Number(m.quantity_delta), 0)).toBeLessThan(0)
    expect(findNegativeBalances(movements)).toEqual([])
  })

  test('still flags the smallest balance the database can represent', () => {
    // The guard against float noise must not become a guard against small real negatives.
    expect(findNegativeBalances([mv('a', '-0.0001')])).toEqual([
      { stockItemId: 'a', balance: -0.0001, movementCount: 1 },
    ])
  })

  test('orders worst first so the biggest data error is read first', () => {
    const movements = [mv('mild', -154), mv('worst', -8617), mv('fine', 12)]

    expect(findNegativeBalances(movements).map((n) => n.stockItemId)).toEqual(['worst', 'mild'])
  })
})

/**
 * The two surfaces that answer "is this balance impossible?" must never disagree.
 *
 * They did, briefly: findNegativeBalances rounded to the stored precision and computeStockStatus
 * compared the raw sum, so an item whose movements cancel exactly was reported clean by the cron
 * and shown to the merchant as "Impossible (negative)". The guard sat on the log-only path and
 * not on the customer-facing one, which is the wrong way round -- a false alarm costs nothing in
 * a log and costs someone an hour on the stock screen.
 *
 * Written against the raw sum on purpose: lib/stock/queries.ts:116 passes exactly that, so
 * rounding before calling computeStockStatus here would test something the app never does.
 */
describe('the stock screen and the cron report agree on what is impossible', () => {
  const cases: Array<{ name: string; deltas: number[]; impossible: boolean }> = [
    // 0.3 - 0.1 - 0.2 sums to -2.8e-17 in floating point. The item holds precisely nothing.
    { name: 'movements that cancel exactly', deltas: [0.3, -0.1, -0.2], impossible: false },
    { name: 'the smallest representable negative', deltas: [-0.0001], impossible: true },
    { name: 'just above that, rounding to zero', deltas: [-0.00004], impossible: false },
    { name: 'a plain zero balance', deltas: [5, -5], impossible: false },
    { name: 'the live staging whole-milk shape', deltas: [-8617], impossible: true },
    { name: 'an ordinary healthy balance', deltas: [40], impossible: false },
  ]

  test.each(cases)('$name', ({ deltas, impossible }) => {
    const movements = deltas.map((d) => mv('item', d))
    const rawSum = deltas.reduce((sum, d) => sum + d, 0)

    const flaggedByCron = findNegativeBalances(movements).length > 0
    // Both par-level branches, because 'negative' is meant to win over each of them.
    const flaggedOnScreenNoPar = computeStockStatus(rawSum, null) === 'negative'
    const flaggedOnScreenWithPar = computeStockStatus(rawSum, 10) === 'negative'

    expect(flaggedByCron).toBe(impossible)
    expect(flaggedOnScreenNoPar).toBe(impossible)
    expect(flaggedOnScreenWithPar).toBe(impossible)
  })

  test('an exactly-cancelling balance still reads as the ordinary state it is', () => {
    const rawSum = 0.3 - 0.1 - 0.2

    expect(rawSum).toBeLessThan(0)
    expect(computeStockStatus(rawSum, null)).toBe('not_tracked')
    expect(computeStockStatus(rawSum, 10)).toBe('out_of_stock')
  })
})
