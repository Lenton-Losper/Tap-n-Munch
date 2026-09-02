/**
 * @jest-environment jsdom
 *
 * WHERE THIS ORDER GOES, AND WHO SENT IT — the card line the reference KDS shows as "EAT-IN".
 *
 * Two rules carry the risk here, and both are about NOT guessing:
 *
 *   - order type is DERIVED from the table, not stored. A table means eat-in; no table means
 *     counter. Zero is not a table (it is a sentinel a writer left behind) and must never read as
 *     eat-in.
 *   - when the server did not say, the card says NOTHING. A card that claims "Counter" because an
 *     older Worker omitted the field would send a waiter to the wrong place — worse than silence.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StationCard } from '@/components/stations/station-card'
import { STATION_COPY, orderContextLabel } from '@/lib/stations/copy'
import { mapStationLinesToKitchenLines, type StationLinesResponseDTO } from '@/lib/stations/map-raw-lines'
import { densityFor } from '@/lib/stations/board-density'

describe('orderContextLabel', () => {
  it('names eat-in and counter using the established words', () => {
    expect(orderContextLabel('eat_in', null)).toBe(STATION_COPY.orderType.eatIn)
    expect(orderContextLabel('counter', null)).toBe(STATION_COPY.orderType.counter)
  })

  it('adds the server when there is one, in one word order for both boards', () => {
    expect(orderContextLabel('eat_in', 'Paulus')).toBe(`${STATION_COPY.orderType.eatIn} · by Paulus`)
    expect(orderContextLabel('counter', 'Paulus')).toBe(`${STATION_COPY.orderType.counter} · by Paulus`)
  })

  it('carries the server alone when the type is unknown', () => {
    expect(orderContextLabel(null, 'Paulus')).toBe('by Paulus')
  })

  it('returns null — never a guess, never an empty string — when neither is known', () => {
    // This is the load-bearing one. A QR order on an older Worker hits exactly this.
    expect(orderContextLabel(null, null)).toBeNull()
    expect(orderContextLabel(null, '')).toBeNull()
    expect(orderContextLabel(null, '   ')).toBeNull()
  })
})

describe('the DTO carries the two new facts through the mapper', () => {
  const dto = (over: Record<string, unknown>): StationLinesResponseDTO =>
    ({
      station: 'kitchen',
      server_time: new Date().toISOString(),
      orders: [
        {
          order_id: 'o1',
          order_number: 64,
          table_number: 1,
          placed_at: new Date().toISOString(),
          seconds_waiting: 10,
          lines: [
            {
              id: 'l1',
              name_snapshot: 'Prawn Vermicelli',
              quantity: 1,
              line_note: null,
              route_to: 'kitchen',
              kitchen_state: 'outstanding',
              bar_state: null,
              cooked_at: null,
              ready_at: null,
              is_ready: false,
              unrouted: false,
              shared_with_other_station: false,
            },
          ],
          ...over,
        },
      ],
    }) as unknown as StationLinesResponseDTO

  it('maps order_type and served_by onto the line', () => {
    const [line] = mapStationLinesToKitchenLines(dto({ order_type: 'eat_in', served_by: 'Paulus' }))
    expect(line.orderType).toBe('eat_in')
    expect(line.servedBy).toBe('Paulus')
  })

  it('maps an older payload that omits both to null, not undefined', () => {
    const [line] = mapStationLinesToKitchenLines(dto({}))
    expect(line.orderType).toBeNull()
    expect(line.servedBy).toBeNull()
  })
})

describe('StationCard renders the context row', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (contextLabel: string | null) => {
    act(() =>
      root.render(
        <StationCard
          testId="c"
          tableLabel="Table 58"
          ageLabel="01:07"
          escalation={null}
          scale={densityFor(1)}
          contextLabel={contextLabel}
        >
          <div>items</div>
        </StationCard>,
      ),
    )
    return container
  }

  it('shows the context when there is one', () => {
    const el = render('Eat-in · by Paulus')
    expect(el.querySelector('[data-testid="card-context"]')?.textContent).toBe('Eat-in · by Paulus')
  })

  it('renders NO element at all when there is nothing to say', () => {
    // Not an empty <p>: an empty element still costs a row of vertical space on every card, at
    // every density tier, on a board whose whole contract is that it must not scroll.
    const el = render(null)
    expect(el.querySelector('[data-testid="card-context"]')).toBeNull()
  })

  it('never outranks the table number', () => {
    const el = render('Eat-in · by Paulus')
    const table = el.querySelector('p.font-black')
    const context = el.querySelector('[data-testid="card-context"]')
    expect(table?.textContent).toBe('Table 58')
    // The table number is black-weight; the context row is medium and muted.
    expect(context?.className).toMatch(/opacity-70/)
    expect(context?.className).not.toMatch(/font-black/)
  })
})
