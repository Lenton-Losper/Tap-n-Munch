import { mapRawLinesToBarRounds, mapRawLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import type { RawOrderLine, RawOrderLineEvent } from '@/lib/stations/schema-assumptions'

function rawLine(overrides: Partial<RawOrderLine>): RawOrderLine {
  return {
    id: 'l1',
    restaurant_id: 'r1',
    order_id: 'o1',
    tab_id: 't1',
    source_item_index: 0,
    menu_item_id: 'm1',
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    created_at: '2026-08-27T20:00:00Z',
    kitchen_state: 'outstanding',
    bar_state: null,
    ...overrides,
  }
}

function rawEvent(overrides: Partial<RawOrderLineEvent>): RawOrderLineEvent {
  return {
    id: 'e1',
    restaurant_id: 'r1',
    order_line_id: 'l1',
    station: 'kitchen',
    from_state: 'outstanding',
    to_state: 'done',
    actor_kind: 'terminal',
    actor_user_id: 'terminal-1',
    occurred_at: '2026-08-27T20:05:00Z',
    ...overrides,
  }
}

describe('mapRawLinesToKitchenLines', () => {
  test('kitchen_state = outstanding needs no event lookup, no cookedAt/readyToRunAt', () => {
    const [line] = mapRawLinesToKitchenLines([rawLine({})], [])
    expect(line.cookedAt).toBeNull()
    expect(line.readyToRunAt).toBeNull()
  })

  test('kitchen_state = done reads the to_state=done transition timestamp as readyToRunAt', () => {
    const events = [rawEvent({ to_state: 'done', occurred_at: '2026-08-27T20:06:00Z' })]
    const [line] = mapRawLinesToKitchenLines([rawLine({ kitchen_state: 'done' })], events)
    expect(line.readyToRunAt).toBe('2026-08-27T20:06:00Z')
  })

  test('current state is read off kitchen_state, never derived by folding events', () => {
    // A stray/late-arriving bar event for the same line must not influence the kitchen read.
    const events = [rawEvent({ station: 'bar', to_state: 'done', occurred_at: '2026-08-27T20:09:00Z' })]
    const [line] = mapRawLinesToKitchenLines([rawLine({ route_to: 'both', kitchen_state: 'outstanding' })], events)
    expect(line.readyToRunAt).toBeNull()
  })

  test('table number comes from the lookup map keyed by order_id, not the line itself', () => {
    const [line] = mapRawLinesToKitchenLines([rawLine({ order_id: 'o42' })], [], { o42: '17' })
    expect(line.tableNumber).toBe('17')
  })

  test('name_snapshot becomes itemName', () => {
    const [line] = mapRawLinesToKitchenLines([rawLine({ name_snapshot: 'Fish and chips' })], [])
    expect(line.itemName).toBe('Fish and chips')
  })

  test('excludes lines routed only to bar', () => {
    expect(mapRawLinesToKitchenLines([rawLine({ route_to: 'bar', kitchen_state: null })], [])).toHaveLength(0)
  })

  test('includes unrouted lines — the screen itself puts them under Unrouted, not this filter', () => {
    expect(
      mapRawLinesToKitchenLines([rawLine({ route_to: 'unrouted', kitchen_state: null })], []),
    ).toHaveLength(1)
  })
})

describe('mapRawLinesToBarRounds', () => {
  test('groups lines sharing an order_id into one round', () => {
    const lines = [
      rawLine({ id: 'l1', order_id: 'o1', route_to: 'bar', bar_state: 'outstanding', name_snapshot: 'IPA' }),
      rawLine({ id: 'l2', order_id: 'o1', route_to: 'bar', bar_state: 'outstanding', name_snapshot: 'Lager' }),
    ]
    const rounds = mapRawLinesToBarRounds(lines, [])
    expect(rounds).toHaveLength(1)
    expect(rounds[0].items.map((i) => i.itemName)).toEqual(['IPA', 'Lager'])
  })

  test('a round is Out only once every line in it has bar_state = done', () => {
    const lines = [
      rawLine({ id: 'l1', order_id: 'o1', route_to: 'bar', bar_state: 'done' }),
      rawLine({ id: 'l2', order_id: 'o1', route_to: 'bar', bar_state: 'outstanding' }),
    ]
    const events = [rawEvent({ order_line_id: 'l1', station: 'bar', to_state: 'done' })]
    expect(mapRawLinesToBarRounds(lines, events)[0].outAt).toBeNull()

    const bothDone = [
      lines[0],
      rawLine({ id: 'l2', order_id: 'o1', route_to: 'bar', bar_state: 'done' }),
    ]
    const bothDoneEvents = [
      ...events,
      rawEvent({ id: 'e2', order_line_id: 'l2', station: 'bar', to_state: 'done', occurred_at: '2026-08-27T20:07:00Z' }),
    ]
    expect(mapRawLinesToBarRounds(bothDone, bothDoneEvents)[0].outAt).toBe('2026-08-27T20:05:00Z')
  })

  test('current state is read off bar_state, never derived by folding events', () => {
    const lines = [rawLine({ id: 'l1', order_id: 'o1', route_to: 'both', bar_state: 'outstanding' })]
    const events = [rawEvent({ order_line_id: 'l1', station: 'kitchen', to_state: 'done' })]
    expect(mapRawLinesToBarRounds(lines, events)[0].outAt).toBeNull()
  })

  test('excludes lines routed only to kitchen', () => {
    expect(mapRawLinesToBarRounds([rawLine({ route_to: 'kitchen', bar_state: null })], [])).toHaveLength(0)
  })

  test("a route_to = both line's kitchen and bar state move independently, never mixed (proven live: order_lines row 89fe25a2 on staging)", () => {
    const lines = [
      rawLine({ id: 'l1', order_id: 'o1', route_to: 'both', kitchen_state: 'done', bar_state: 'outstanding' }),
    ]
    const events = [rawEvent({ order_line_id: 'l1', station: 'kitchen', to_state: 'done' })]
    const [kitchenLine] = mapRawLinesToKitchenLines(lines, events)
    const [round] = mapRawLinesToBarRounds(lines, events)
    expect(kitchenLine.readyToRunAt).not.toBeNull()
    expect(round.outAt).toBeNull()
  })
})
