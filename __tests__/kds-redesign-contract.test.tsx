/**
 * @jest-environment jsdom
 *
 * THE KDS REDESIGN'S OWN CONTRACT — 2026-09-01.
 *
 * Pins the properties an operational wall screen depends on and which nothing else asserts:
 * density thresholds and the floor past them, the absence of any horizontal overflow mechanism,
 * the 12h partition, Ready's collapse and expansion, unified terminology, and the guarantee that
 * a route_to 'both' line still reaches both boards.
 *
 * DISPLAY ONLY. Every check here is about layout and copy. Business logic, state transitions,
 * routing semantics and the wire vocabulary are untouched by this redesign and are covered by
 * their own suites — station-batch-bump, route-to-both-needs-every-station, waiter-led-order-lines.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { BarScreen } from '@/components/stations/bar-screen'
import { STATION_COPY } from '@/lib/stations/copy'
import {
  densityFor,
  ROOMY_MAX_ROUNDS,
  STANDARD_MAX_ROUNDS,
  COMPACT_MAX_ROUNDS,
  DENSE_MAX_ROUNDS,
} from '@/lib/stations/board-density'
import { formatMinutesShort, UNRESOLVED_AFTER_MINUTES } from '@/lib/stations/age'
import { buildKitchenBoard, buildBarBoard } from '@/lib/stations/grouping'
import type { KitchenLine, BarRound } from '@/lib/stations/types'

const NOW = Date.parse('2026-09-01T12:00:00.000Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const NO_BUMP = async () => ({ ok: true, total: 0, failedLineIds: [] })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function line(over: Partial<KitchenLine> & { id: string }): KitchenLine {
  return {
    orderId: 'o1', tableNumber: '3', orderNumber: 1, itemName: 'Steak', quantity: 1,
    lineNote: null, routeTo: 'kitchen', state: 'outstanding',
    placedAt: minsAgo(5), cookedAt: null, readyAt: null,
    unrouted: false, sharedWithOtherStation: false, ...over,
  }
}
const kitchenLines = (n: number, over: Partial<KitchenLine> = {}) =>
  Array.from({ length: n }, (_, i) =>
    line({ id: `l${i}`, tableNumber: String(i + 1), itemName: `Item ${i}`, ...over }),
  )

const q = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const renderKitchen = (lines: KitchenLine[]) =>
  act(() => {
    root.render(<KitchenScreen lines={lines} now={NOW} connectionState="live" onBump={NO_BUMP} />)
  })

/* ------------------------------------------------------------------ density thresholds */

describe('adaptive density: 1-4 roomy, 5-8 standard, 9-12 compact, 13-20 dense', () => {
  it.each([
    [1, 'roomy'], [4, 'roomy'],
    [5, 'standard'], [8, 'standard'],
    [9, 'compact'], [12, 'compact'],
    [13, 'dense'], [20, 'dense'],
  ])('%i active cards -> %s', (count, expected) => {
    expect(densityFor(count).density).toBe(expected)
  })

  it('the thresholds are exactly 4 / 8 / 12 / 20', () => {
    expect([ROOMY_MAX_ROUNDS, STANDARD_MAX_ROUNDS, COMPACT_MAX_ROUNDS, DENSE_MAX_ROUNDS])
      .toEqual([4, 8, 12, 20])
  })

  it('STOPS shrinking past 20 — the floor, not another tier', () => {
    const at20 = densityFor(20)
    for (const n of [21, 30, 60, 200]) {
      const beyond = densityFor(n)
      expect(beyond.density).toBe('dense')
      // Identical scale object: no smaller type, no thinner borders, no tighter padding.
      expect(beyond.itemClass).toBe(at20.itemClass)
      expect(beyond.tableClass).toBe(at20.tableClass)
      expect(beyond.cardPadClass).toBe(at20.cardPadClass)
    }
  })

  it('never drops the item name below the 24px readability floor, at ANY count', () => {
    for (const n of [1, 5, 10, 20, 21, 100]) expect(densityFor(n).itemClass).toBe('text-2xl')
  })
})

/* ------------------------------------------------------- no horizontal overflow, ever */

describe('the board can only ever overflow vertically', () => {
  it('uses CSS grid, never multi-column, for the active surface', () => {
    // `columns-N` in a height-constrained box flows content into further columns to the RIGHT,
    // without limit — that is what produced horizontal scrolling in the Ready zone. A grid with
    // an explicit column count can only wrap downward.
    for (const n of [1, 5, 10, 20, 40]) {
      const cls = densityFor(n).columnsClass
      expect(cls).toMatch(/grid grid-cols-\d/)
      expect(cls).not.toMatch(/(^|\s)columns-\d/)
    }
  })

  it('the rendered active grid scrolls y and hides x', () => {
    renderKitchen(kitchenLines(30))
    const grid = container.querySelector('[data-testid="active-grid"]')!
    expect(grid.className).toMatch(/overflow-y-auto/)
    expect(grid.className).toMatch(/overflow-x-hidden/)
  })

  it('the ready dispatch list scrolls y and hides x', () => {
    renderKitchen([...kitchenLines(2), line({ id: 'r1', state: 'ready', readyAt: minsAgo(3) })])
    const list = container.querySelector('[data-testid="ready-dispatch-list"]')!
    expect(list.className).toMatch(/overflow-y-auto/)
    expect(list.className).toMatch(/overflow-x-hidden/)
  })
})

/* -------------------------------------------------------- 12h unresolved partitioning */

describe('12-hour partition: moved out of the layout, never out of the board', () => {
  const OLD = UNRESOLVED_AFTER_MINUTES + 60
  const NEW = 30

  it('a >12h line leaves Active and appears in OLDER UNRESOLVED', () => {
    const board = buildKitchenBoard(
      [line({ id: 'old', placedAt: minsAgo(OLD) }), line({ id: 'new', placedAt: minsAgo(NEW) })],
      NOW,
    )
    expect(board.olderUnresolved.map((l) => l.id)).toEqual(['old'])
    expect(board.activeByTable.flatMap((g) => g.lines).map((l) => l.id)).toEqual(['new'])
  })

  it('a >12h READY line leaves the dispatch queue too', () => {
    const board = buildKitchenBoard(
      [line({ id: 'oldready', state: 'ready', placedAt: minsAgo(OLD), readyAt: minsAgo(OLD) })],
      NOW,
    )
    expect(board.readyRows).toHaveLength(0)
    expect(board.olderUnresolved.map((l) => l.id)).toEqual(['oldready'])
  })

  it('partitioned lines keep their exact state — nothing is collected or voided', () => {
    const board = buildKitchenBoard(
      [line({ id: 'a', state: 'cooked', placedAt: minsAgo(OLD), cookedAt: minsAgo(OLD) })],
      NOW,
    )
    expect(board.olderUnresolved[0].state).toBe('cooked')
  })

  it('renders collapsed by default with a visible count, and opens on tap', async () => {
    renderKitchen([line({ id: 'o', placedAt: minsAgo(OLD) }), ...kitchenLines(1)])
    const section = container.querySelector('[data-testid="older-unresolved-section"]')!
    expect(section.getAttribute('data-older-count')).toBe('1')
    expect(section.getAttribute('data-older-open')).toBe('false')
    expect(q('[data-testid="older-unresolved-row"]')).toHaveLength(0)
    expect(section.textContent).toContain(STATION_COPY.older.heading)

    await act(async () => {
      ;(container.querySelector('[data-testid="older-unresolved-toggle"]') as HTMLButtonElement).click()
    })
    expect(q('[data-testid="older-unresolved-row"]')).toHaveLength(1)
  })

  it('is absent entirely when nothing is old — no empty chrome', () => {
    renderKitchen(kitchenLines(3))
    expect(container.querySelector('[data-testid="older-unresolved-section"]')).toBeNull()
  })

  it('dead work no longer inflates the density tier (the compounding harm)', () => {
    // Production 2026-09-01: 12 stale + 3 live pushed a ROOMY board to COMPACT.
    const lines = [...kitchenLines(3), ...kitchenLines(12).map((l, i) =>
      line({ ...l, id: `old${i}`, tableNumber: `9${i}`, placedAt: minsAgo(OLD) }))]
    const board = buildKitchenBoard(lines, NOW)
    expect(board.olderUnresolved).toHaveLength(12)
    expect(densityFor(board.activeByTable.length).density).toBe('roomy')
  })
})

/* --------------------------------------------------------------- ready collapse/expand */

describe('Ready collapses when empty and expands only as far as it needs', () => {
  it('collapses to a single summary row when there is nothing ready', () => {
    renderKitchen(kitchenLines(2))
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(ready.getAttribute('data-ready-collapsed')).toBe('true')
    expect(ready.getAttribute('data-ready-count')).toBe('0')
    expect(ready.className).not.toMatch(/max-h-/)
    expect(container.querySelector('[data-testid="ready-dispatch-list"]')).toBeNull()
  })

  it('expands with a capped max height once it has rows', () => {
    renderKitchen([...kitchenLines(2), line({ id: 'r', state: 'ready', readyAt: minsAgo(2) })])
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(ready.getAttribute('data-ready-collapsed')).toBe('false')
    expect(ready.getAttribute('data-ready-count')).toBe('1')
    expect(ready.className).toMatch(/max-h-/)
  })

  it('Active is content-height so READY follows the work, not the viewport bottom', () => {
    renderKitchen(kitchenLines(2))
    const active = container.querySelector('[data-testid="active-section"]')!
    // `flex 0 1 auto`: sized to its cards, still able to shrink and scroll when they overflow.
    // With `flex-1` it claimed the whole remainder and pushed Ready to the bottom of the screen,
    // leaving a dead band in the middle of a quiet board.
    expect(active.className).toMatch(/flex-\[0_1_auto\]/)
    expect(active.className).not.toMatch(/(^|\s)flex-1(\s|$)/)
    expect(active.className).toMatch(/min-h-0/)
  })

  it('cards are never stretched to their grid row height', () => {
    renderKitchen(kitchenLines(6))
    const grid = container.querySelector('[data-testid="active-grid"]')!
    // items-start: a one-line card stays one line tall even beside a three-item card.
    expect(grid.className).toMatch(/items-start/)
  })
})

/* ------------------------------------------------------------------------ terminology */

describe('one vocabulary across both screens', () => {
  it('both call the transition into ready "Ready"', () => {
    expect(STATION_COPY.kitchen.readyButton).toBe('Ready')
    expect(STATION_COPY.bar.readyButton).toBe('Ready')
    expect(STATION_COPY.kitchen.allReadyButton).toBe(STATION_COPY.bar.allReadyButton)
  })

  it('both call collection "Collected"', () => {
    expect(STATION_COPY.kitchen.collectedButton).toBe('Collected')
    expect(STATION_COPY.bar.collectedButton).toBe('Collected')
  })

  it('both head the dispatch zone "Ready" — no "Waiting for collection"', () => {
    expect(STATION_COPY.kitchen.readyHeading).toBe('Ready')
    expect(STATION_COPY.bar.readyHeading).toBe('Ready')
  })

  it('the retired words are gone from station copy entirely', () => {
    const all = JSON.stringify(STATION_COPY)
    expect(all).not.toContain('Ready to run')
    expect(all).not.toContain('All out')
    expect(all).not.toContain('Waiting for collection')
  })

  it("the kitchen KEEPS Cooked — it is a real intermediate step, not duplicate wording", () => {
    expect(STATION_COPY.kitchen.cookedButton).toBe('Cooked')
    expect(STATION_COPY.bar).not.toHaveProperty('cookedButton')
  })
})

/* ------------------------------------------------------------------------ time display */

describe('time is whole minutes and never seconds', () => {
  it.each([[0, '<1m'], [0.4, '<1m'], [1, '1m'], [3.9, '3m'], [12, '12m'], [1440, '1440m']])(
    'formatMinutesShort(%s) -> %s', (input, expected) => {
      expect(formatMinutesShort(input as number)).toBe(expected)
    },
  )

  it('no rendered clock on either board contains a colon', () => {
    renderKitchen([...kitchenLines(3), line({ id: 'r', state: 'ready', readyAt: minsAgo(6) })])
    const clocks = [
      ...q('[data-testid="card-age"]'),
      ...q('[data-testid="dispatch-row-clock"]'),
    ].map((e) => e.textContent ?? '')
    expect(clocks.length).toBeGreaterThan(0)
    for (const t of clocks) expect(t).not.toContain(':')
  })
})

/* ------------------------------------------------------- routing: 'both' reaches both */

describe("a route_to 'both' line still reaches both boards", () => {
  it('appears on the kitchen board', () => {
    const board = buildKitchenBoard([line({ id: 'b1', routeTo: 'both', sharedWithOtherStation: true })], NOW)
    expect(board.activeByTable.flatMap((g) => g.lines).map((l) => l.id)).toEqual(['b1'])
    expect(board.olderUnresolved).toHaveLength(0)
  })

  it('appears on the bar board', () => {
    const round: BarRound = {
      id: 'r1', tableNumber: '3', orderNumber: 1, placedAt: minsAgo(5), unrouted: false,
      items: [{ id: 'b1', itemName: 'Coffee', quantity: 4, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null }],
    }
    const board = buildBarBoard([round], NOW)
    expect(board.active.flatMap((r) => r.items).map((i) => i.id)).toEqual(['b1'])
  })

  it('the redesign does not touch routing — unrouted still bypasses both surfaces', () => {
    const board = buildKitchenBoard([line({ id: 'u', routeTo: 'unrouted', unrouted: true })], NOW)
    expect(board.unrouted.map((l) => l.id)).toEqual(['u'])
    expect(board.activeByTable).toHaveLength(0)
  })
})

/* ----------------------------------------------------------------------- oldest first */

describe('active work is ordered oldest first', () => {
  it('orders table cards by their oldest line', () => {
    const board = buildKitchenBoard(
      [
        line({ id: 'newest', tableNumber: '1', placedAt: minsAgo(2) }),
        line({ id: 'oldest', tableNumber: '2', placedAt: minsAgo(60) }),
      ],
      NOW,
    )
    // Oldest table first. Urgency is carried by colour, not by position, so the board reads
    // front-to-back in the order the work arrived.
    expect(board.activeByTable.map((g) => g.tableNumber)).toEqual(['2', '1'])
  })

  it('orders lines within a card oldest first', () => {
    const board = buildKitchenBoard(
      [
        line({ id: 'b', tableNumber: '5', itemName: 'Later', placedAt: minsAgo(3) }),
        line({ id: 'a', tableNumber: '5', itemName: 'Earlier', placedAt: minsAgo(30) }),
      ],
      NOW,
    )
    expect(board.activeByTable[0].lines.map((l) => l.id)).toEqual(['a', 'b'])
  })
})
