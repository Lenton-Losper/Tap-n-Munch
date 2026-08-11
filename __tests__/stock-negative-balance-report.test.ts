import {
  groupNegativesByRestaurant,
  type NegativeBalanceReportRow,
} from '../lib/stock/report-negative-balances'

const row = (
  overrides: Partial<NegativeBalanceReportRow> & { stockItemId: string; balance: number; restaurantId: string },
): NegativeBalanceReportRow => ({
  name: overrides.stockItemId,
  parLevel: null,
  movementCount: 1,
  ...overrides,
})

describe('groupNegativesByRestaurant', () => {
  test('returns nothing for no negatives', () => {
    expect(groupNegativesByRestaurant([])).toEqual([])
  })

  test('groups per restaurant so one merchant is not buried under another', () => {
    const grouped = groupNegativesByRestaurant([
      row({ stockItemId: 'milk', balance: -10, restaurantId: 'r1' }),
      row({ stockItemId: 'beans', balance: -20, restaurantId: 'r2' }),
      row({ stockItemId: 'sugar', balance: -5, restaurantId: 'r1' }),
    ])

    expect(grouped.map((g) => g.restaurantId)).toEqual(['r2', 'r1'])
    expect(grouped.find((g) => g.restaurantId === 'r1')!.rows.map((r) => r.stockItemId)).toEqual([
      'milk',
      'sugar',
    ])
  })

  test('orders worst first within a restaurant and by worst item across restaurants', () => {
    // The staging shape: one restaurant, two items, the -8617 read before the -154.
    const grouped = groupNegativesByRestaurant([
      row({ stockItemId: 'espresso beans', balance: -154, restaurantId: 'r1', parLevel: 50 }),
      row({ stockItemId: 'whole milk', balance: -8617, restaurantId: 'r1' }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].rows.map((r) => r.balance)).toEqual([-8617, -154])
  })

  test('does not mutate the array it was given', () => {
    const rows = [
      row({ stockItemId: 'a', balance: -1, restaurantId: 'r1' }),
      row({ stockItemId: 'b', balance: -9, restaurantId: 'r1' }),
    ]
    const before = rows.map((r) => r.stockItemId)

    groupNegativesByRestaurant(rows)

    expect(rows.map((r) => r.stockItemId)).toEqual(before)
  })
})
