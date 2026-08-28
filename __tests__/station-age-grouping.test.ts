import { ageMinutes, readyToRunEscalation, sortOldestFirst } from '@/lib/stations/age'
import { buildBarBoard, buildKitchenBoard } from '@/lib/stations/grouping'
import type { BarRound, KitchenLine } from '@/lib/stations/types'

describe('readyToRunEscalation — the brief\'s exact boundaries: white 0-2, amber 3-5, red 5+', () => {
  test.each([
    [0, 'white'],
    [2, 'white'],
    [3, 'amber'],
    [5, 'amber'],
    [6, 'red'],
    [60, 'red'],
  ])('%i minutes -> %s', (minutes, expected) => {
    expect(readyToRunEscalation(minutes)).toBe(expected)
  })
})

describe('ageMinutes', () => {
  test('floors to whole minutes and never goes negative', () => {
    const now = Date.parse('2026-08-27T20:10:00Z')
    expect(ageMinutes('2026-08-27T20:09:00Z', now)).toBe(1)
    expect(ageMinutes('2026-08-27T20:09:59Z', now)).toBe(0)
    expect(ageMinutes('2026-08-27T20:11:00Z', now)).toBe(0)
  })
})

describe('sortOldestFirst', () => {
  test('orders ascending by the given timestamp', () => {
    const items = [{ id: 'b', t: '2026-08-27T20:02:00Z' }, { id: 'a', t: '2026-08-27T20:01:00Z' }]
    expect(sortOldestFirst(items, (i) => i.t).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

// REBUILT 2026-08-28 for the real four-state model (lib/orders/order-lines.ts). kitchenLineStatus
// and barRoundIsOut are retired along with them — see lib/stations/types.ts's docblock: a line
// can only ever reach either screen as 'outstanding' or (kitchen only) 'cooked', so `state` on
// KitchenLine is read directly rather than derived from timestamps, and BarRound carries no
// "is this out yet" flag at all, because a round that reached 'ready' would not be in the array
// this module is given in the first place.

function kitchenLine(overrides: Partial<KitchenLine>): KitchenLine {
  return {
    id: 'kl',
    orderId: 'o1',
    tableNumber: '1',
    orderNumber: 100,
    itemName: 'Item',
    cookedAt: null,
    quantity: 1,
    lineNote: null,
    routeTo: 'kitchen',
    state: 'outstanding',
    placedAt: '2026-08-27T20:00:00Z',
    unrouted: false,
    sharedWithOtherStation: false,
    ...overrides,
  }
}

function barRound(overrides: Partial<BarRound>): BarRound {
  return {
    id: 'br',
    tableNumber: '1',
    orderNumber: 100,
    items: [{ itemName: 'Item', quantity: 1, lineNote: null }],
    placedAt: '2026-08-27T20:00:00Z',
    unrouted: false,
    ...overrides,
  }
}

describe('buildKitchenBoard', () => {
  test('route_to = both, state = cooked lands in the cooked zone, and can be bumped independently of the bar screen', () => {
    const line = kitchenLine({ id: 'shared', routeTo: 'both', state: 'cooked', sharedWithOtherStation: true })
    const board = buildKitchenBoard([line])
    expect(board.cooked.map((l) => l.id)).toEqual(['shared'])
  })

  test('unrouted = true never lands in outstanding or cooked', () => {
    const board = buildKitchenBoard([kitchenLine({ id: 'u', unrouted: true })])
    expect(board.unrouted.map((l) => l.id)).toEqual(['u'])
    expect(board.outstandingByTable).toHaveLength(0)
    expect(board.cooked).toHaveLength(0)
  })

  test('outstanding lines are grouped by table, oldest table first', () => {
    const board = buildKitchenBoard([
      kitchenLine({ id: 'newer', tableNumber: '9', placedAt: '2026-08-27T20:05:00Z' }),
      kitchenLine({ id: 'older', tableNumber: '4', placedAt: '2026-08-27T20:00:00Z' }),
    ])
    expect(board.outstandingByTable.map((t) => t.tableNumber)).toEqual(['4', '9'])
  })

  test('cooked lines are sorted oldest (by order placedAt) first', () => {
    const board = buildKitchenBoard([
      kitchenLine({ id: 'newer', state: 'cooked', placedAt: '2026-08-27T20:05:00Z' }),
      kitchenLine({ id: 'older', state: 'cooked', placedAt: '2026-08-27T20:00:00Z' }),
    ])
    expect(board.cooked.map((l) => l.id)).toEqual(['older', 'newer'])
  })
})

describe('buildBarBoard', () => {
  test('a round appears in IN regardless of routeTo mix, as long as it is not unrouted', () => {
    const round = barRound({ id: 'shared' })
    const board = buildBarBoard([round])
    expect(board.in.map((r) => r.id)).toEqual(['shared'])
  })

  test('unrouted = true never lands in IN', () => {
    const board = buildBarBoard([barRound({ id: 'u', unrouted: true })])
    expect(board.unrouted.map((r) => r.id)).toEqual(['u'])
    expect(board.in).toHaveLength(0)
  })

  test('IN rounds are sorted oldest first', () => {
    const board = buildBarBoard([
      barRound({ id: 'newer', placedAt: '2026-08-27T20:05:00Z' }),
      barRound({ id: 'older', placedAt: '2026-08-27T20:00:00Z' }),
    ])
    expect(board.in.map((r) => r.id)).toEqual(['older', 'newer'])
  })

  test('there is no "out" list — a round that reached ready is simply absent from the input array', () => {
    const board = buildBarBoard([barRound({ id: 'still-in' })])
    expect((board as unknown as { out?: unknown }).out).toBeUndefined()
  })
})
