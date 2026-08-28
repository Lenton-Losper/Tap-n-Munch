import { ageMinutes, readyToRunEscalation, sortByUrgency, sortOldestFirst } from '@/lib/stations/age'
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

describe('sortByUrgency', () => {
  test('a louder escalation rises above a quieter one regardless of age', () => {
    const items = [
      { id: 'old-quiet', escalation: 'white' as const, clock: 1 },
      { id: 'new-loud', escalation: 'red' as const, clock: 2 },
    ]
    expect(sortByUrgency(items, (i) => i.escalation, (i) => i.clock).map((i) => i.id)).toEqual([
      'new-loud',
      'old-quiet',
    ])
  })

  test('within the same tier, oldest still comes first — this is what makes it read as FIFO', () => {
    const items = [
      { id: 'newer', escalation: 'amber' as const, clock: 2 },
      { id: 'older', escalation: 'amber' as const, clock: 1 },
    ]
    expect(sortByUrgency(items, (i) => i.escalation, (i) => i.clock).map((i) => i.id)).toEqual([
      'older',
      'newer',
    ])
  })

  test('stale sinks below white — an abandoned round must not outrank a live one', () => {
    const items = [
      { id: 'stale', escalation: 'stale' as const, clock: 1 },
      { id: 'white', escalation: 'white' as const, clock: 2 },
    ]
    expect(sortByUrgency(items, (i) => i.escalation, (i) => i.clock).map((i) => i.id)).toEqual([
      'white',
      'stale',
    ])
  })
})

// REBUILT 20260829160000 for the pinned Ready zone (lib/orders/order-lines.ts's fifth state,
// 'collected'). A line can now reach either screen as 'outstanding', 'cooked' or 'ready' — never
// 'collected' or 'voided', which leave the board entirely (see lib/stations/types.ts's docblock).

function kitchenLine(overrides: Partial<KitchenLine>): KitchenLine {
  return {
    id: 'kl',
    orderId: 'o1',
    tableNumber: '1',
    orderNumber: 100,
    itemName: 'Item',
    cookedAt: null,
    readyAt: null,
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

function barItem(overrides: Partial<BarRound['items'][number]> = {}): BarRound['items'][number] {
  return { id: 'brl-1', itemName: 'Item', quantity: 1, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null, ...overrides }
}

function barRound(overrides: Partial<BarRound>): BarRound {
  return {
    id: 'br',
    tableNumber: '1',
    orderNumber: 100,
    items: [barItem()],
    placedAt: '2026-08-27T20:00:00Z',
    unrouted: false,
    ...overrides,
  }
}

const NOW = Date.parse('2026-08-27T20:10:00Z')

describe('buildKitchenBoard', () => {
  test('outstanding and cooked land in the SAME active zone — the previous two-zone split is gone', () => {
    const board = buildKitchenBoard(
      [
        kitchenLine({ id: 'a', state: 'outstanding' }),
        kitchenLine({ id: 'b', state: 'cooked', tableNumber: '2' }),
      ],
      NOW,
    )
    const activeIds = board.activeByTable.flatMap((t) => t.lines.map((l) => l.id))
    expect(activeIds.sort()).toEqual(['a', 'b'])
  })

  test('a ready line lands in the pinned ready zone, not active — as a flat row, not a table group', () => {
    const board = buildKitchenBoard([kitchenLine({ id: 'r', state: 'ready', readyAt: '2026-08-27T20:05:00Z' })], NOW)
    expect(board.readyRows.map((row) => row.lineId)).toEqual(['r'])
    expect(board.activeByTable).toHaveLength(0)
  })

  test('route_to = both, state = cooked lands in active, and can be bumped independently of the bar screen', () => {
    const line = kitchenLine({ id: 'shared', routeTo: 'both', state: 'cooked', sharedWithOtherStation: true })
    const board = buildKitchenBoard([line], NOW)
    expect(board.activeByTable.flatMap((t) => t.lines.map((l) => l.id))).toEqual(['shared'])
  })

  test('unrouted = true never lands in active or ready', () => {
    const board = buildKitchenBoard([kitchenLine({ id: 'u', unrouted: true })], NOW)
    expect(board.unrouted.map((l) => l.id)).toEqual(['u'])
    expect(board.activeByTable).toHaveLength(0)
    expect(board.readyRows).toHaveLength(0)
  })

  test('a table with one outstanding and one ready line appears in BOTH zones, each carrying only its own line', () => {
    const board = buildKitchenBoard(
      [
        kitchenLine({ id: 'still-cooking', tableNumber: '4', state: 'outstanding' }),
        kitchenLine({ id: 'already-ready', tableNumber: '4', state: 'ready', readyAt: '2026-08-27T20:05:00Z' }),
      ],
      NOW,
    )
    expect(board.activeByTable.map((t) => t.tableNumber)).toEqual(['4'])
    expect(board.activeByTable[0].lines.map((l) => l.id)).toEqual(['still-cooking'])
    expect(board.readyRows.map((row) => row.tableNumber)).toEqual(['4'])
    expect(board.readyRows.map((row) => row.lineId)).toEqual(['already-ready'])
  })

  test('ready rows are flat, not grouped — two ready lines on the same table are two separate rows', () => {
    const board = buildKitchenBoard(
      [
        kitchenLine({ id: 'ribeye', tableNumber: '4', state: 'ready', itemName: 'Ribeye', readyAt: '2026-08-27T20:05:00Z' }),
        kitchenLine({ id: 'fries', tableNumber: '4', state: 'ready', itemName: 'Fries', readyAt: '2026-08-27T20:06:00Z' }),
      ],
      NOW,
    )
    expect(board.readyRows).toHaveLength(2)
    expect(board.readyRows.every((row) => row.tableNumber === '4')).toBe(true)
  })

  test('a louder table rises above a quieter, older one in the active zone', () => {
    const board = buildKitchenBoard(
      [
        // amber (10-19 min outstanding)
        kitchenLine({ id: 'amber-older', tableNumber: '9', placedAt: '2026-08-27T19:55:00Z' }),
        // red (20+ min outstanding), placed AFTER the amber one but louder
        kitchenLine({ id: 'red-newer', tableNumber: '4', placedAt: '2026-08-27T19:45:00Z' }),
      ],
      NOW,
    )
    expect(board.activeByTable.map((t) => t.tableNumber)).toEqual(['4', '9'])
  })

  test('same tier sorts oldest table first — reads as FIFO', () => {
    const board = buildKitchenBoard(
      [
        kitchenLine({ id: 'newer', tableNumber: '9', placedAt: '2026-08-27T20:05:00Z' }),
        kitchenLine({ id: 'older', tableNumber: '4', placedAt: '2026-08-27T20:00:00Z' }),
      ],
      NOW,
    )
    expect(board.activeByTable.map((t) => t.tableNumber)).toEqual(['4', '9'])
  })
})

describe('buildBarBoard', () => {
  test('a round with only outstanding/cooked items appears in active, not ready', () => {
    const round = barRound({ id: 'r1', items: [barItem({ id: 'i1', state: 'outstanding' })] })
    const board = buildBarBoard([round], NOW)
    expect(board.active.map((r) => r.id)).toEqual(['r1'])
    expect(board.readyRows).toHaveLength(0)
  })

  test('a round with a mix of states appears in BOTH zones, each carrying only its own items', () => {
    const round = barRound({
      id: 'mixed',
      tableNumber: '7',
      items: [
        barItem({ id: 'pending', state: 'outstanding' }),
        barItem({ id: 'poured', state: 'ready', readyAt: '2026-08-27T20:05:00Z' }),
      ],
    })
    const board = buildBarBoard([round], NOW)
    expect(board.active.map((r) => r.id)).toEqual(['mixed'])
    expect(board.active[0].items.map((i) => i.id)).toEqual(['pending'])
    expect(board.readyRows.map((row) => row.lineId)).toEqual(['poured'])
    expect(board.readyRows[0].tableNumber).toBe('7')
  })

  test('unrouted = true never lands in active or ready', () => {
    const board = buildBarBoard([barRound({ id: 'u', unrouted: true })], NOW)
    expect(board.unrouted.map((r) => r.id)).toEqual(['u'])
    expect(board.active).toHaveLength(0)
    expect(board.readyRows).toHaveLength(0)
  })

  /**
   * REVERSED 20260829 (second pass): the bar's TO MAKE zone was ruled neutral at four cards and
   * that ruling was walked back once the board held twelve-plus — see lib/stations/age.ts's
   * barActiveEscalation. This test used to pin pure FIFO; it now pins the opposite on purpose.
   */
  test('active sorts by urgency now too, on the softer bar bands — a louder round rises', () => {
    const board = buildBarBoard(
      [
        // white (< 15 min on barActiveEscalation)
        barRound({ id: 'quiet-older', placedAt: '2026-08-27T20:05:00Z' }),
        // red (>= 30 min), placed BEFORE the quiet one but louder
        barRound({ id: 'loud-newer', placedAt: '2026-08-27T19:35:00Z' }),
      ],
      NOW,
    )
    expect(board.active.map((r) => r.id)).toEqual(['loud-newer', 'quiet-older'])
  })

  test('within the same tier, active is still FIFO — oldest round first', () => {
    const board = buildBarBoard(
      [
        barRound({ id: 'newer', placedAt: '2026-08-27T20:09:00Z' }),
        barRound({ id: 'older', placedAt: '2026-08-27T20:00:00Z' }),
      ],
      NOW,
    )
    expect(board.active.map((r) => r.id)).toEqual(['older', 'newer'])
  })

  test('ready rows sort by urgency too, on their own (softer-than-kitchen) bands', () => {
    const board = buildBarBoard(
      [
        barRound({ id: 'r1', items: [barItem({ id: 'quiet-older', state: 'ready', readyAt: '2026-08-27T20:08:00Z' })] }),
        barRound({ id: 'r2', items: [barItem({ id: 'loud-newer', state: 'ready', readyAt: '2026-08-27T19:49:00Z' })] }),
      ],
      NOW,
    )
    // loud-newer has sat ready 21 minutes (barReadyEscalation red, >= 15); quiet-older 2 (white).
    expect(board.readyRows.map((row) => row.lineId)).toEqual(['loud-newer', 'quiet-older'])
  })

  test('ready rows are flat — two ready items in one round are two separate rows, not one', () => {
    const round = barRound({
      id: 'r1',
      tableNumber: '4',
      items: [
        barItem({ id: 'ipa', itemName: 'IPA', state: 'ready', readyAt: '2026-08-27T20:05:00Z' }),
        barItem({ id: 'lager', itemName: 'Lager', state: 'ready', readyAt: '2026-08-27T20:06:00Z' }),
      ],
    })
    const board = buildBarBoard([round], NOW)
    expect(board.readyRows).toHaveLength(2)
    expect(board.readyRows.every((row) => row.tableNumber === '4')).toBe(true)
  })
})
