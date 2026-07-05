import {
  filterOrdersByStationScope,
  orderVisibleForStationScope,
} from '../lib/order-routing'

const kitchenOrder = { id: 'k1', items: [{ route_to: 'kitchen' }] }
const barOrder = { id: 'b1', items: [{ route_to: 'bar' }] }
const bothOrder = { id: 'x1', items: [{ route_to: 'both' }] }
const allOrders = [kitchenOrder, barOrder, bothOrder]

describe('filterOrdersByStationScope', () => {
  test('no station scope shows all orders', () => {
    expect(filterOrdersByStationScope(allOrders, { hasKitchenStation: false, hasBarStation: false })).toEqual(
      allOrders
    )
  })

  test('kitchen scope only includes kitchen and both routes', () => {
    const filtered = filterOrdersByStationScope(allOrders, {
      hasKitchenStation: true,
      hasBarStation: false,
    })
    expect(filtered.map((o) => o.id)).toEqual(['k1', 'x1'])
  })

  test('bar scope only includes bar and both routes', () => {
    const filtered = filterOrdersByStationScope(allOrders, {
      hasKitchenStation: false,
      hasBarStation: true,
    })
    expect(filtered.map((o) => o.id)).toEqual(['b1', 'x1'])
  })

  test('both station scopes union kitchen and bar', () => {
    const filtered = filterOrdersByStationScope(allOrders, {
      hasKitchenStation: true,
      hasBarStation: true,
    })
    expect(filtered.map((o) => o.id)).toEqual(['k1', 'b1', 'x1'])
  })
})

describe('orderVisibleForStationScope', () => {
  test('completed-tab merge respects station scope', () => {
    expect(
      orderVisibleForStationScope(barOrder, { hasKitchenStation: true, hasBarStation: false })
    ).toBe(false)
    expect(
      orderVisibleForStationScope(barOrder, { hasKitchenStation: false, hasBarStation: true })
    ).toBe(true)
    expect(
      orderVisibleForStationScope(kitchenOrder, { hasKitchenStation: true, hasBarStation: true })
    ).toBe(true)
  })
})
