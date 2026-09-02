/**
 * @jest-environment jsdom
 *
 * THE THREE OPERATOR-CLARITY CHANGES, PINNED.
 *
 * Measured against the reference KDS a real kitchen already uses:
 *
 *   1. EVERY TICKET IS CALLABLE. "No table" is true and useless — a counter order handed to the
 *      person waiting for it cannot be called by a phrase that names no order.
 *   2. QUANTITY IS ITS OWN RIGHT-ALIGNED COLUMN. Down a six-line ticket, a count embedded in a
 *      sentence moves horizontally with every dish name above it.
 *   3. AN IDLE BOARD READS AS ALIVE AND EMPTY, not as a page that failed to load.
 *
 * The recorded guarantee that zero is not a table is asserted here too, because that is the rule
 * most at risk from a change to the same label.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { orderIdentifier, STATION_COPY } from '@/lib/stations/copy'
import { densityFor } from '@/lib/stations/board-density'
import type { KitchenLine } from '@/lib/stations/types'

describe('orderIdentifier', () => {
  it('prefers the table, because that is what staff shout', () => {
    expect(orderIdentifier('58', 64, 'kitchen')).toBe('Table 58')
    expect(orderIdentifier('58', null, 'bar')).toBe('Table 58')
  })

  it('falls back to the order number when there is no table', () => {
    expect(orderIdentifier('', 66, 'kitchen')).toBe('Order #66')
    expect(orderIdentifier('   ', '204', 'bar')).toBe('Order #204')
  })

  it('keeps the established wording when there is neither, rather than inventing a third phrase', () => {
    expect(orderIdentifier('', null, 'kitchen')).toBe(STATION_COPY.kitchen.tableLabel(''))
    expect(orderIdentifier('', undefined, 'bar')).toBe(STATION_COPY.bar.tableLabel(''))
  })

  it('never renders zero as a table — the recorded fix, still true through the new path', () => {
    // Zero is a sentinel a writer left behind, normalised to null server-side. If it ever reaches
    // here as a string it must not become "Table 0".
    expect(orderIdentifier('', 0, 'kitchen')).toBe(STATION_COPY.kitchen.tableLabel(''))
    expect(orderIdentifier('', 5, 'kitchen')).not.toContain('Table')
  })
})

describe('quantity is its own column', () => {
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

  /** Driven through the real board rather than the row in isolation: StationLineRow takes a bump
   *  handle from useCardBump, and rebuilding that by hand would be testing my fixture, not the UI. */
  const renderBoard = () => {
    const line: KitchenLine = {
      id: 'l1',
      orderId: 'o1',
      tableNumber: '58',
      orderNumber: 64,
      orderType: 'eat_in',
      servedBy: 'Paulus',
      itemName: 'Spring Rolls',
      quantity: 2,
      lineNote: null,
      routeTo: 'kitchen',
      state: 'outstanding',
      placedAt: new Date().toISOString(),
      cookedAt: null,
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: false,
    } as unknown as KitchenLine
    act(() =>
      root.render(
        <KitchenScreen
          lines={[line]}
          now={Date.now()}
          connectionState="live"
          onBump={async () => [] as never}
          venueName="Riviera"
        />,
      ),
    )
    return container
  }

  it('renders the count in its own element, not inside the item name', () => {
    const el = renderBoard()
    const qty = el.querySelector('[data-testid="line-quantity"]')
    expect(qty?.textContent).toBe('2')
    const name = el.querySelector('[data-testid="active-table-card"] p.font-bold')
    expect(name?.textContent).toBe('Spring Rolls')
    expect(name?.textContent).not.toContain('2×')
  })

  it('gives the count the same size as the dish, right-aligned and tabular', () => {
    // Getting a count wrong is the error that reaches a table, so it is not secondary text.
    const qty = renderBoard().querySelector('[data-testid="line-quantity"]') as HTMLElement
    expect(qty.className).toMatch(/text-right/)
    expect(qty.className).toMatch(/tabular-nums/)
    expect(qty.className).toMatch(/font-black/)
  })
})

describe('the idle board', () => {
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

  it('says nothing is waiting, in something readable from across a kitchen', () => {
    act(() =>
      root.render(
        <KitchenScreen
          lines={[] as KitchenLine[]}
          now={Date.now()}
          connectionState="live"
          onBump={async () => [] as never}
          venueName="Riviera"
        />,
      ),
    )
    const empty = container.querySelector('[data-testid="active-zone-empty"]') as HTMLElement
    expect(empty).toBeTruthy()
    expect(empty.textContent).toBe(STATION_COPY.kitchen.activeEmpty)
    // Not a 16px grey line in a corner of a 1920px wall.
    expect(empty.querySelector('p')?.className).toMatch(/text-3xl/)
    expect(empty.className).toMatch(/justify-center/)
  })

  it('still identifies the venue and station when there is no work at all', () => {
    // An empty board that does not say whose it is looks identical to a broken one.
    act(() =>
      root.render(
        <KitchenScreen
          lines={[] as KitchenLine[]}
          now={Date.now()}
          connectionState="live"
          onBump={async () => [] as never}
          venueName="Riviera"
        />,
      ),
    )
    const header = container.querySelector('[data-testid="station-venue-header"]')
    expect(header?.textContent).toContain('Kitchen')
    expect(header?.textContent).toContain('Riviera')
  })
})
