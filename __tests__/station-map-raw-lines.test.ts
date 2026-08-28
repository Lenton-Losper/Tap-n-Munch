/**
 * REBUILT 2026-08-28: mapStationLinesToKitchenLines / mapStationLinesToBarRounds map the REAL
 * GET /api/station/lines response shape (StationLinesResponseDTO) rather than a raw
 * order_lines/order_line_events table dump against a guessed schema.
 */
import { mapStationLinesToBarRounds, mapStationLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import type { StationLinesResponseDTO, StationLineDTO, StationOrderCardDTO } from '@/lib/stations/map-raw-lines'

function line(overrides: Partial<StationLineDTO>): StationLineDTO {
  return {
    id: 'l1',
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    unrouted: false,
    shared_with_other_station: false,
    ...overrides,
  }
}

function card(overrides: Partial<StationOrderCardDTO> & { lines: StationLineDTO[] }): StationOrderCardDTO {
  return {
    order_id: 'o1',
    order_number: 100,
    table_number: '4',
    order_instructions: null,
    placed_at: '2026-08-27T20:00:00Z',
    seconds_waiting: 60,
    ...overrides,
  }
}

function response(cards: StationOrderCardDTO[], station: 'kitchen' | 'bar' = 'kitchen'): StationLinesResponseDTO {
  return { station, orders: cards, server_time: '2026-08-27T20:10:00Z' }
}

describe('mapStationLinesToKitchenLines', () => {
  test('kitchen_state = outstanding maps to state "outstanding"', () => {
    const [kl] = mapStationLinesToKitchenLines(response([card({ lines: [line({})] })]))
    expect(kl.state).toBe('outstanding')
  })

  test('kitchen_state = cooked maps to state "cooked"', () => {
    const [kl] = mapStationLinesToKitchenLines(
      response([card({ lines: [line({ kitchen_state: 'cooked' })] })]),
    )
    expect(kl.state).toBe('cooked')
  })

  test('an unrecognised kitchen_state falls open to "outstanding", not throwing', () => {
    const [kl] = mapStationLinesToKitchenLines(
      response([card({ lines: [line({ kitchen_state: 'some_future_state' })] })]),
    )
    expect(kl.state).toBe('outstanding')
  })

  test('placedAt comes from the order card, not the line', () => {
    const [kl] = mapStationLinesToKitchenLines(
      response([card({ order_id: 'o42', placed_at: '2026-08-27T19:55:00Z', lines: [line({})] })]),
    )
    expect(kl.placedAt).toBe('2026-08-27T19:55:00Z')
    expect(kl.orderId).toBe('o42')
  })

  test('table number comes from the order card', () => {
    const [kl] = mapStationLinesToKitchenLines(response([card({ table_number: 17, lines: [line({})] })]))
    expect(kl.tableNumber).toBe('17')
  })

  test('name_snapshot becomes itemName', () => {
    const [kl] = mapStationLinesToKitchenLines(
      response([card({ lines: [line({ name_snapshot: 'Fish and chips' })] })]),
    )
    expect(kl.itemName).toBe('Fish and chips')
  })

  test('unrouted and shared_with_other_station pass straight through', () => {
    const [kl] = mapStationLinesToKitchenLines(
      response([card({ lines: [line({ unrouted: true, shared_with_other_station: true })] })]),
    )
    expect(kl.unrouted).toBe(true)
    expect(kl.sharedWithOtherStation).toBe(true)
  })

  test('every line on every card is flattened into one array', () => {
    const kls = mapStationLinesToKitchenLines(
      response([
        card({ order_id: 'o1', lines: [line({ id: 'l1' }), line({ id: 'l2' })] }),
        card({ order_id: 'o2', lines: [line({ id: 'l3' })] }),
      ]),
    )
    expect(kls.map((l) => l.id)).toEqual(['l1', 'l2', 'l3'])
  })
})

describe('mapStationLinesToBarRounds', () => {
  test('one order card maps to one round, carrying every line on it as an item', () => {
    const rounds = mapStationLinesToBarRounds(
      response(
        [
          card({
            order_id: 'o1',
            lines: [
              line({ id: 'l1', name_snapshot: 'IPA', route_to: 'bar', bar_state: 'outstanding' }),
              line({ id: 'l2', name_snapshot: 'Lager', route_to: 'bar', bar_state: 'outstanding' }),
            ],
          }),
        ],
        'bar',
      ),
    )
    expect(rounds).toHaveLength(1)
    expect(rounds[0].items.map((i) => i.itemName)).toEqual(['IPA', 'Lager'])
  })

  test('a card with no lines produces no round', () => {
    const rounds = mapStationLinesToBarRounds(response([card({ lines: [] })], 'bar'))
    expect(rounds).toHaveLength(0)
  })

  test('unrouted is true for the round if ANY line on it is unrouted, even a mixed card', () => {
    const rounds = mapStationLinesToBarRounds(
      response(
        [
          card({
            lines: [
              line({ id: 'l1', route_to: 'bar', bar_state: 'outstanding', unrouted: false }),
              line({ id: 'l2', route_to: 'unrouted', bar_state: 'outstanding', unrouted: true }),
            ],
          }),
        ],
        'bar',
      ),
    )
    expect(rounds[0].unrouted).toBe(true)
  })

  test('line_note passes through onto the round item', () => {
    const rounds = mapStationLinesToBarRounds(
      response([card({ lines: [line({ line_note: 'no ice' })] })], 'bar'),
    )
    expect(rounds[0].items[0].lineNote).toBe('no ice')
  })

  test('multiple order cards produce independent rounds', () => {
    const rounds = mapStationLinesToBarRounds(
      response(
        [
          card({ order_id: 'o1', table_number: '2', lines: [line({ id: 'l1' })] }),
          card({ order_id: 'o2', table_number: '9', lines: [line({ id: 'l2' })] }),
        ],
        'bar',
      ),
    )
    expect(rounds.map((r) => r.id)).toEqual(['o1', 'o2'])
    expect(rounds.map((r) => r.tableNumber)).toEqual(['2', '9'])
  })
})
