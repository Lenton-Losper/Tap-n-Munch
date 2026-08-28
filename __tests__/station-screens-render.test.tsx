/**
 * @jest-environment jsdom
 *
 * Proves the kitchen and bar screens render against seeded, schema-shaped fixture data
 * (lib/stations/dev-fixture.ts). Mounts the real components with react-dom/client, same pattern
 * __tests__/350-feed-connection-indicator-renders.test.tsx uses for the same reason: a unit test
 * on the grouping functions alone cannot show the DOM actually reads right.
 *
 * REBUILT 20260829160000 for the board rebuild: two zones per screen now (active + a pinned
 * Ready), and 'ready' lines can finally reach a screen at all — see lib/stations/types.ts.
 *
 * WHAT THIS FILE CANNOT DO: jsdom has no layout engine, so "the board fits without scrolling" is
 * not assertable here — scrollHeight and clientHeight are both zero. That is
 * tests/e2e/station-board-wall-fit.spec.ts's job, in a real browser at 1920x1080. What IS
 * assertable here is everything the layout is DERIVED from: which zone a line lands in, how many
 * colours a full board produces per zone, and that density responds to load.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { BarScreen } from '@/components/stations/bar-screen'
import {
  buildBarFixture,
  buildBarWallFixture,
  buildKitchenFixture,
  buildKitchenWallFixture,
} from '@/lib/stations/dev-fixture'
import { STATION_COPY } from '@/lib/stations/copy'
import type { StationBumpAction, StationBumpOutcome } from '@/lib/stations/bump'

let container: HTMLDivElement
let root: Root

const NO_BUMP = async (lineIds: string[], _action: StationBumpAction): Promise<StationBumpOutcome> => ({
  ok: true,
  total: lineIds.length,
  failedLineIds: [],
})

const q = (selector: string) => Array.from(container.querySelectorAll(selector))
const buttonsLabelled = (label: string) =>
  Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === label)

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('KitchenScreen renders against seeded data', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderKitchen(onBump = NO_BUMP) {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
  }

  it('renders the page and both zones, active before ready in DOM order', () => {
    renderKitchen()
    expect(container.querySelector('[data-testid="kitchen-screen"]')).toBeTruthy()
    expect(container.textContent).toContain(STATION_COPY.kitchen.pageTitle)
    const active = container.querySelector('[data-testid="active-section"]')
    const ready = container.querySelector('[data-testid="ready-section"]')
    expect(active).toBeTruthy()
    expect(ready).toBeTruthy()
    // DEFECT: "finished food sits above active work" — pinned this so it cannot come back.
    expect(active!.compareDocumentPosition(ready!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a table with an outstanding line and a cooked line lands in ONE active card, not two zones', () => {
    renderKitchen()
    const table4 = q('[data-testid="active-table-card"]').find((c) => c.textContent?.includes('Table 4'))!
    expect(table4.textContent).toContain('Ribeye')
    expect(table4.textContent).toContain('Truffle fries')
  })

  it('a ready line appears only in the Ready zone, not active', () => {
    renderKitchen()
    const readyZone = container.querySelector('[data-testid="ready-section"]')!
    expect(readyZone.textContent).toContain('Onion rings')
    const activeZone = container.querySelector('[data-testid="active-section"]')!
    expect(activeZone.textContent).not.toContain('Onion rings')
  })

  it('an outstanding line carries the Cooked button, a cooked line the Ready to run button', () => {
    renderKitchen()
    const friesRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Truffle fries'))!
    expect(friesRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.cookedButton)
    const ribeyeRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Ribeye'))!
    expect(ribeyeRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.readyToRunButton)
  })

  it('a Ready line carries the Collected button, which clears it off the pinned zone', () => {
    renderKitchen()
    const readyRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(readyRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.collectedButton)
  })

  it('tapping Collected bumps exactly that one line with the collected action', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['kl-7'], 'collected')
  })

  it('shows several colours in the active zone, not one wall of one colour', () => {
    renderKitchen()
    const active = new Set(q('[data-testid="active-table-card"]').map((c) => c.getAttribute('data-escalation')))
    expect(active.size).toBeGreaterThanOrEqual(2)
  })

  it('the allergy/note carrier renders loud, not muted — line_note is the only field this schema has for it', () => {
    renderKitchen()
    const note = q('[data-testid="line-note"]').find((n) => n.textContent?.includes('medium'))!
    expect(note).toBeTruthy()
    expect(note.className).not.toMatch(/opacity-70/)
  })

  it('route_to = unrouted renders under the loud NOT SENT heading, not inside table 9', () => {
    renderKitchen()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')
    expect(unrouted).toBeTruthy()
    expect(unrouted!.textContent).toContain('Side of mash')
    expect(unrouted!.textContent).toContain('NOT SENT')
    expect(unrouted!.querySelector('[data-testid="unrouted-item"]')?.textContent).toContain(
      STATION_COPY.unrouted.itemNote,
    )
    const table9 = q('[data-testid="active-table-card"]').find((el) => el.textContent?.includes('Table 9'))
    expect(table9!.textContent).not.toContain('Side of mash')
  })

  it('tapping Cooked bumps exactly that one line', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.cookedButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['kl-5'], 'cooked')
  })

  it('tapping Ready to run bumps exactly that one line', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.readyToRunButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['kl-3'], 'ready_to_run')
  })
})

describe('BarScreen renders against seeded data', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderBar(onBump = NO_BUMP) {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('renders the page and both zones, active before ready in DOM order', () => {
    renderBar()
    expect(container.querySelector('[data-testid="bar-screen"]')).toBeTruthy()
    const active = container.querySelector('[data-testid="bar-active-section"]')
    const ready = container.querySelector('[data-testid="bar-ready-section"]')
    expect(active).toBeTruthy()
    expect(ready).toBeTruthy()
    expect(active!.compareDocumentPosition(ready!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a round with one drink poured and one not appears in BOTH zones, split per line', () => {
    renderBar()
    const activeGrid = container.querySelector('[data-testid="bar-active-grid"]')!
    const readyGrid = container.querySelector('[data-testid="bar-ready-grid"]')!
    expect(activeGrid.textContent).toContain('Gin and tonic')
    expect(activeGrid.textContent).not.toContain('Sparkling water')
    expect(readyGrid.textContent).toContain('Sparkling water')
    expect(readyGrid.textContent).not.toContain('Gin and tonic')
  })

  it('TO MAKE is FIFO — oldest round first', () => {
    renderBar()
    const cards = Array.from(
      container.querySelector('[data-testid="bar-active-grid"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(cards[0].textContent).toContain('Table 2')
  })

  it('every drink in a TO MAKE round carries its own Out button', () => {
    renderBar()
    const row = q('[data-testid="bar-active-grid"] [data-testid="station-line-row"]').find((r) =>
      r.textContent?.includes('IPA'),
    )!
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.outButton)
  })

  it('a Waiting-for-collection drink carries its own Collected button', () => {
    renderBar()
    const row = q('[data-testid="bar-ready-grid"] [data-testid="station-line-row"]').find((r) =>
      r.textContent?.includes('Sparkling water'),
    )!
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.collectedButton)
  })

  it('TO MAKE never escalates colour with age — the standing bar ruling, unchanged', () => {
    renderBar()
    for (const card of q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]')) {
      expect(card.className).not.toMatch(/amber|red-/)
      expect(card.getAttribute('data-escalation')).toBe('none')
    }
  })

  it('Waiting for collection DOES escalate colour with age — the one deliberate difference', () => {
    renderBar()
    const readyCard = q('[data-testid="bar-ready-grid"] [data-testid="bar-round-card"]')[0]
    expect(readyCard.getAttribute('data-escalation')).not.toBe('none')
  })

  it('route_to = unrouted renders under the loud NOT SENT heading, not in TO MAKE, with no button', () => {
    renderBar()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')!
    expect(unrouted.textContent).toContain('Milkshake')
    expect(unrouted.textContent).toContain(STATION_COPY.unrouted.itemNote)
    expect(unrouted.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-testid="bar-active-grid"]')!.textContent).not.toContain('Milkshake')
  })

  it('tapping Out bumps ONE drink, by line id — a round is not poured all at once', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderBar(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.bar.outButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['bl-1'], 'out')
  })

  it('tapping Collected bumps ONE drink, by line id', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderBar(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.bar.collectedButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['bl-3'], 'collected')
  })
})

/**
 * ============================================================================================
 * THE VOLUME CASES. TWENTY ROUNDS, WHICH IS THE ONLY SIZE THE LAYOUT QUESTION EXISTS AT.
 * ============================================================================================
 */
describe('the kitchen board at twenty rounds', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function renderWall(onBump = NO_BUMP) {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
  }

  it('really does put twenty table cards on the board, split across both zones', () => {
    renderWall()
    const active = q('[data-testid="active-table-card"]').length
    const ready = q('[data-testid="ready-table-card"]').length
    expect(active + ready).toBe(20)
    expect(ready).toBe(5)
    expect(container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-card-count')).toBe('20')
  })

  /**
   * THE LOAD-BEARING COLOUR TEST, unchanged in spirit from the first density rebuild: the property
   * that separates a working board from a broken one is that a spread of ages across a FULL board
   * produces several different colours in EACH zone, checked separately so one zone's four tiers
   * cannot hide the other zone painting everything one colour.
   */
  it('paints a spread of ages in several different colours in BOTH zones, not one wall of one colour', () => {
    renderWall()
    const active = new Set(q('[data-testid="active-table-card"]').map((c) => c.getAttribute('data-escalation')))
    const ready = new Set(q('[data-testid="ready-table-card"]').map((c) => c.getAttribute('data-escalation')))

    expect(active.size).toBeGreaterThanOrEqual(3)
    expect(ready.size).toBeGreaterThanOrEqual(3)
    expect(new Set([...active, ...ready])).toEqual(new Set(['white', 'amber', 'red', 'stale']))
  })

  it('spends the wall on size when quiet and buys columns with type size when full', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const quiet = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')

    renderWall()
    const full = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')

    expect(quiet).not.toBe(full)
  })

  it('reads an absent table as words, and 12877 minutes as days, on the real board', () => {
    renderWall()
    expect(container.textContent).toContain('No table')
    expect(container.textContent).not.toContain('Table 0')
    expect(container.textContent).toContain('8d')
    expect(container.textContent).not.toContain('12877')
  })

  it('keeps the unrouted line out of its table card and under the loud heading', () => {
    renderWall()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')!
    expect(unrouted.textContent).toContain('Chef special')
    const table6 = q('[data-testid="active-table-card"]').find((c) => c.textContent?.includes('Table 6'))!
    expect(table6.textContent).not.toContain('Chef special')
  })
})

describe('per-line is the default, and the per-table control is one action over exactly its own lines', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function wallCard(testId: string, tableLabel: string) {
    return q(`[data-testid="${testId}"]`).find((c) => c.textContent?.startsWith(tableLabel))!
  }

  it('gives every line its own button — a salad and a steak do not finish together', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    // Table 16 has four outstanding lines and therefore four Cooked buttons of its own.
    const card = wallCard('active-table-card', 'Table 16')
    const rows = Array.from(card.querySelectorAll('[data-testid="station-line-row"]'))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.cookedButton)
    }
  })

  it('is ONE call carrying exactly the ids that card is showing, not a loop of taps', async () => {
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
    const card = wallCard('active-table-card', 'Table 16')
    const rowIds = Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) =>
      r.getAttribute('data-line-id'),
    )
    const control = card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement

    await act(async () => control.click())

    expect(onBump).toHaveBeenCalledTimes(1)
    expect(onBump).toHaveBeenCalledWith(rowIds, 'cooked')
  })

  it('never reaches a line on another card, another table or another zone', async () => {
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
    const card = wallCard('active-table-card', 'Table 16')
    const ownIds = new Set(
      Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) => r.getAttribute('data-line-id')),
    )
    const everyOtherId = q('[data-testid="station-line-row"]')
      .map((r) => r.getAttribute('data-line-id'))
      .filter((id) => !ownIds.has(id))

    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())

    const [sentIds] = onBump.mock.calls[0] as [string[], StationBumpAction]
    expect(sentIds).toHaveLength(ownIds.size)
    for (const id of sentIds) expect(everyOtherId).not.toContain(id)
  })

  it('is absent on a card holding one line, where it would only be a second way to do the same tap', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const single = wallCard('active-table-card', 'Table 8')
    expect(single.querySelectorAll('[data-testid="station-line-row"]')).toHaveLength(1)
    expect(single.querySelector('[data-testid="per-card-control"]')).toBeNull()

    const multi = wallCard('active-table-card', 'Table 16')
    expect(multi.querySelector('[data-testid="per-card-control"]')).toBeTruthy()
  })

  it('says so, on the card and on the rows, when only some of what was tapped moved', async () => {
    const refusedIds: string[] = []
    const onBump = jest.fn(async (lineIds: string[]): Promise<StationBumpOutcome> => {
      const failed = lineIds.slice(0, 2)
      refusedIds.push(...failed)
      return { ok: false, total: lineIds.length, failedLineIds: failed }
    })

    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
    const card = wallCard('active-table-card', 'Table 16')
    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())

    const banner = card.querySelector('[data-testid="card-bump-failure"]')!
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('data-failed-count')).toBe('2')
    expect(banner.querySelector('[data-testid="card-bump-failure-count"]')!.textContent).toBe('2/4')

    const marked = Array.from(card.querySelectorAll('[data-testid="station-line-row"][data-failed="true"]'))
    expect(marked.map((r) => r.getAttribute('data-line-id'))).toEqual(refusedIds)
    expect(card.querySelectorAll('[data-testid="line-bump-failed"]')).toHaveLength(2)
  })
})

describe('the bar board at twenty rounds', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function renderWall(onBump = NO_BUMP) {
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
  }

  it('tiles twenty rounds across both zones', () => {
    renderWall()
    expect(q('[data-testid="bar-round-card"]')).toHaveLength(20)
  })

  it('TO MAKE still carries no age escalation at any age, across the whole spread', () => {
    renderWall()
    const escalations = new Set(
      q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]').map((c) => c.getAttribute('data-escalation')),
    )
    expect(escalations).toEqual(new Set(['none']))
  })

  it('Waiting for collection paints several different colours, including the quietest and the loudest', () => {
    renderWall()
    const escalations = new Set(
      q('[data-testid="bar-ready-grid"] [data-testid="bar-round-card"]').map((c) => c.getAttribute('data-escalation')),
    )
    expect(escalations.size).toBeGreaterThanOrEqual(3)
  })

  it('shows the age itself in readable units, including the multi-day one', () => {
    renderWall()
    expect(container.textContent).toContain('8d')
    expect(container.textContent).not.toContain('12877')
  })

  it('carries a per-round shortcut over the same per-line ids, exactly like the kitchen', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderWall(onBump)
    // Table 4 is the four-drink TO MAKE round.
    const card = q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]').find((c) =>
      c.textContent?.startsWith('Table 4'),
    )!
    const rowIds = Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) =>
      r.getAttribute('data-line-id'),
    )
    expect(rowIds).toHaveLength(4)

    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())
    expect(onBump).toHaveBeenCalledTimes(1)
    expect(onBump).toHaveBeenCalledWith(rowIds, 'out')
  })
})
