import { ageMinutes, readyToRunEscalation, sortOldestFirst } from '@/lib/stations/age'
import { buildBarBoard, buildKitchenBoard } from '@/lib/stations/grouping'
import type { BarRound, KitchenLine } from '@/lib/stations/types'
import { kitchenLineStatus, barRoundIsOut } from '@/lib/stations/types'

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

function kitchenLine(overrides: Partial<KitchenLine>): KitchenLine {
  return {
    id: 'kl',
    tableNumber: '1',
    waiterName: 'Ana',
    itemName: 'Item',
    quantity: 1,
    station: 'grill',
    routeTo: 'kitchen',
    createdAt: '2026-08-27T20:00:00Z',
    cookedAt: null,
    readyToRunAt: null,
    ...overrides,
  }
}

function barRound(overrides: Partial<BarRound>): BarRound {
  return {
    id: 'br',
    tableNumber: '1',
    waiterName: 'Ana',
    items: [{ itemName: 'Item', quantity: 1 }],
    routeTo: 'bar',
    createdAt: '2026-08-27T20:00:00Z',
    outAt: null,
    ...overrides,
  }
}

describe('kitchenLineStatus', () => {
  test('outstanding -> cooked -> ready_to_run, derived from the event timestamps present', () => {
    expect(kitchenLineStatus(kitchenLine({}))).toBe('outstanding')
    expect(kitchenLineStatus(kitchenLine({ cookedAt: '2026-08-27T20:01:00Z' }))).toBe('cooked')
    expect(
      kitchenLineStatus(
        kitchenLine({ cookedAt: '2026-08-27T20:01:00Z', readyToRunAt: '2026-08-27T20:02:00Z' }),
      ),
    ).toBe('ready_to_run')
  })
})

describe('barRoundIsOut', () => {
  test('true only once outAt is set', () => {
    expect(barRoundIsOut(barRound({}))).toBe(false)
    expect(barRoundIsOut(barRound({ outAt: '2026-08-27T20:05:00Z' }))).toBe(true)
  })
})

describe('buildKitchenBoard', () => {
  test('route_to = both appears, and can be bumped independently of the bar screen', () => {
    const line = kitchenLine({ id: 'shared', routeTo: 'both', cookedAt: 'x', readyToRunAt: 'y' })
    const board = buildKitchenBoard([line])
    expect(board.readyToRun.map((l) => l.id)).toEqual(['shared'])
  })

  test('route_to = unrouted never lands in outstanding or ready-to-run', () => {
    const board = buildKitchenBoard([kitchenLine({ id: 'u', routeTo: 'unrouted' })])
    expect(board.unrouted.map((l) => l.id)).toEqual(['u'])
    expect(board.outstandingByTable).toHaveLength(0)
    expect(board.readyToRun).toHaveLength(0)
  })

  test('route_to = bar only never lands on the kitchen board at all', () => {
    const board = buildKitchenBoard([kitchenLine({ id: 'bar-only', routeTo: 'bar' })])
    expect(board.unrouted).toHaveLength(0)
    expect(board.outstandingByTable).toHaveLength(0)
  })
})

describe('buildBarBoard', () => {
  test('route_to = both appears, independent of the kitchen screen', () => {
    const round = barRound({ id: 'shared', routeTo: 'both' })
    const board = buildBarBoard([round])
    expect(board.in.map((r) => r.id)).toEqual(['shared'])
  })

  test('route_to = unrouted never lands in in or out', () => {
    const board = buildBarBoard([barRound({ id: 'u', routeTo: 'unrouted' })])
    expect(board.unrouted.map((r) => r.id)).toEqual(['u'])
    expect(board.in).toHaveLength(0)
    expect(board.out).toHaveLength(0)
  })

  test('out rounds are sorted most-recently-out first', () => {
    const board = buildBarBoard([
      barRound({ id: 'older-out', outAt: '2026-08-27T20:00:00Z' }),
      barRound({ id: 'newer-out', outAt: '2026-08-27T20:05:00Z' }),
    ])
    expect(board.out.map((r) => r.id)).toEqual(['newer-out', 'older-out'])
  })
})
