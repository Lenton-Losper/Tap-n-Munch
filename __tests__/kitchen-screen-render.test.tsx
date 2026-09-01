/**
 * @jest-environment jsdom
 *
 * Proves the second-pass kitchen board (components/stations/kitchen-screen.tsx) renders correctly
 * against seeded fixture data (lib/stations/dev-fixture.ts). Mounts the real component with
 * react-dom/client, same pattern __tests__/station-screens-render.test.tsx (the pre-redesign file,
 * left untouched for the owner to reconcile) already used.
 *
 * NEW FILE for the second-pass redesign: 68/32 fixed surfaces, a NOT SENT strip OUTSIDE the
 * scrollable area, and a Ready zone that is flat DispatchRowView rows instead of grouped cards —
 * none of which the old file's testids (`ready-table-card`, `ready-grid`) describe any more.
 *
 * WHAT THIS FILE CANNOT DO: jsdom has no layout engine, so "68/32 in real pixels" and "the board
 * never scrolls" are not assertable here — that is tests/e2e/station-board-wall-fit.spec.ts's job
 * in a real browser at 1920x1080 (see this rebuild's own report on that spec's testids needing the
 * owner's reconciliation). What IS assertable here: DOM order, which zone a line lands in, the
 * MM:SS clock format, the per-line vs per-table controls, and the recoverable-collected-tap
 * ruling end to end.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { buildKitchenFixture, buildKitchenWallFixture } from '@/lib/stations/dev-fixture'
import { STATION_COPY } from '@/lib/stations/copy'
import type { KitchenLine } from '@/lib/stations/types'
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

describe('KitchenScreen — layout skeleton', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderKitchen(lines: KitchenLine[] = buildKitchenFixture(now), onBump = NO_BUMP) {
    act(() => {
      root.render(<KitchenScreen lines={lines} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('renders the page, a scrollable body, and both fixed surfaces in DOM order', () => {
    renderKitchen()
    expect(container.querySelector('[data-testid="kitchen-screen"]')).toBeTruthy()
    expect(container.textContent).toContain(STATION_COPY.kitchen.pageTitle)
    const body = container.querySelector('[data-testid="station-board-body"]')!
    const active = container.querySelector('[data-testid="active-section"]')!
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(body).toBeTruthy()
    expect(active).toBeTruthy()
    expect(ready).toBeTruthy()
    // DEFECT this pins: finished food must never sit above active work.
    expect(active.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives Ready only the height it needs and lets Active take the rest', () => {
    renderKitchen()
    const active = container.querySelector('[data-testid="active-section"]')!
    const ready = container.querySelector('[data-testid="ready-section"]')!
    // REDESIGN 2026-09-01: the fixed 68/32 is gone. Active takes whatever Ready does not need
    // (flex-1), and Ready sizes to its rows up to a cap (shrink-0 + max-h). A quiet board used to
    // spend a third of a 1080p wall rendering "Nothing ready."
    // Active is CONTENT-height (flex 0 1 auto): it takes what its cards need, shrinks and scrolls
    // when they exceed the space Ready leaves, and never claims the viewport's full remainder —
    // that is what put a 500-600px dead band between Active and Ready on a quiet board.
    expect(active.className).toMatch(/flex-\[0_1_auto\]/)
    expect(active.className).not.toMatch(/flex-\[68\]/)
    expect(ready.className).toMatch(/shrink-0/)
    expect(ready.className).not.toMatch(/flex-\[32\]/)
  })

  it('renders the NOT SENT strip OUTSIDE station-board-body, before it in DOM order', () => {
    renderKitchen()
    const strip = container.querySelector('[data-testid="unrouted-section"]')!
    const body = container.querySelector('[data-testid="station-board-body"]')!
    expect(strip).toBeTruthy()
    expect(body.contains(strip)).toBe(false)
    expect(strip.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.textContent).toContain('NOT SENT')
    expect(strip.textContent).toContain('Side of mash')
  })

  it('renders no NOT SENT strip at all when nothing is unrouted', () => {
    renderKitchen(buildKitchenFixture(now).filter((line) => !line.unrouted))
    expect(container.querySelector('[data-testid="unrouted-section"]')).toBeNull()
  })
})

describe('KitchenScreen — the active surface', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderKitchen(onBump = NO_BUMP) {
    act(() => {
      root.render(<KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('a table with an outstanding line and a cooked line lands in ONE active card', () => {
    renderKitchen()
    const table4 = q('[data-testid="active-table-card"]').find((c) => c.textContent?.includes('Table 4'))!
    expect(table4.textContent).toContain('Ribeye')
    expect(table4.textContent).toContain('Truffle fries')
  })

  it('a ready line does not appear in the active surface at all', () => {
    renderKitchen()
    const active = container.querySelector('[data-testid="active-section"]')!
    expect(active.textContent).not.toContain('Onion rings')
  })

  it('shows the card age as whole minutes, the quietest element on the card', () => {
    renderKitchen()
    const table4 = q('[data-testid="active-table-card"]').find((c) => c.textContent?.includes('Table 4'))!
    const age = table4.querySelector('[data-testid="card-age"]')!
    // REDESIGN 2026-09-01: whole minutes, no seconds — see formatMinutesShort.
    expect(age.textContent).toBe('1m')
  })

  it('an outstanding line carries Cooked, a cooked line carries Ready to run', () => {
    renderKitchen()
    const friesRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Truffle fries'))!
    expect(friesRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.cookedButton)
    const ribeyeRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Ribeye'))!
    expect(ribeyeRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.readyButton)
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
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.readyButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['kl-3'], 'ready_to_run')
  })

  it('the allergy/note carrier renders loud, not muted', () => {
    renderKitchen()
    const note = q('[data-testid="line-note"]').find((n) => n.textContent?.includes('medium'))!
    expect(note).toBeTruthy()
    expect(note.className).not.toMatch(/opacity-70/)
  })

  it('route_to = unrouted stays out of its table card', () => {
    renderKitchen()
    const table9 = q('[data-testid="active-table-card"]').find((el) => el.textContent?.includes('Table 9'))!
    expect(table9.textContent).not.toContain('Side of mash')
  })
})

describe('KitchenScreen — the ready surface is a dispatch queue, not cards', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderKitchen(onBump = NO_BUMP) {
    act(() => {
      root.render(<KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('renders no production cards in the ready zone — dispatch-row, not active-table-card', () => {
    renderKitchen()
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(ready.querySelector('[data-testid="active-table-card"]')).toBeNull()
    expect(ready.querySelector('[data-testid="dispatch-row"]')).toBeTruthy()
  })

  it('reads as "TABLE | qty x item | Nm" in four fixed slots', () => {
    renderKitchen()
    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(row.textContent).toContain('Table 5')
    expect(row.textContent).toContain('1× Onion rings')
    const clock = row.querySelector('[data-testid="dispatch-row-clock"]')!
    // REDESIGN 2026-09-01: whole minutes, no seconds, no "READY" word. The row already sits under
    // a READY heading; repeating it on every row was noise, and a ticking MM:SS was the most
    // animated thing on the wall. Urgency is the border accent (data-escalation), not this number.
    expect(clock.textContent).toBe('2m')
  })

  it('a ready row carries the Collected button', () => {
    renderKitchen()
    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.collectedButton)
  })

  it('tapping Collected bumps exactly that one line with the collected action', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['kl-7'], 'collected')
  })

  it('has no per-row group shortcut — every ready row is its own tap, nothing to group by', () => {
    renderKitchen()
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(ready.querySelector('[data-testid="per-card-control"]')).toBeNull()
  })

  it('says zero with the heading alone when the ready surface is empty', () => {
    renderKitchen()
    act(() => {
      root.render(
        <KitchenScreen
          lines={buildKitchenFixture(now).filter((line) => line.state !== 'ready')}
          now={now}
          connectionState="live"
          onBump={NO_BUMP}
        />,
      )
    })
    const ready = container.querySelector('[data-testid="ready-section"]')!
    // REDESIGN 2026-09-01: the heading already reads "READY · 0". A second sentence saying the
    // same thing cost a whole row of a wall screen for no information, so an empty Ready zone is
    // now exactly one heading tall and Active takes the rest.
    expect(ready.getAttribute('data-ready-collapsed')).toBe('true')
    expect(ready.getAttribute('data-ready-count')).toBe('0')
    expect(ready.textContent).toContain(STATION_COPY.kitchen.readyHeading)
    expect(ready.textContent).toContain('0')
    expect(ready.textContent).not.toContain(STATION_COPY.kitchen.readyEmpty)
    expect(container.querySelector('[data-testid="ready-empty"]')).toBeNull()
  })
})

describe('KitchenScreen — a collected tap is recoverable, not instant', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')
  const fullLines = buildKitchenFixture(now)
  const linesWithoutKl7 = fullLines.filter((line) => line.id !== 'kl-7')

  it('does not strike the row through while the server still reports it ready (race case)', async () => {
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(<KitchenScreen lines={fullLines} now={now} connectionState="live" onBump={onBump} />)
    })
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())

    // The fixture passed to the component has not changed — the server would still report kl-7 as
    // ready — so the row must still read as an ordinary, uncollected row: the merge trusts the
    // server's own list over local memory whenever the two disagree.
    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(row.getAttribute('data-collected')).toBe('false')
  })

  it('once the line actually leaves the server response, the row stays visible, struck through, with Undo', async () => {
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(<KitchenScreen lines={fullLines} now={now} connectionState="live" onBump={onBump} />)
    })
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())

    // Simulate the next real refetch: the server has dropped kl-7 (collected, per the route's own
    // filter) from what this screen is told about.
    act(() => {
      root.render(<KitchenScreen lines={linesWithoutKl7} now={now} connectionState="live" onBump={onBump} />)
    })

    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(row.getAttribute('data-collected')).toBe('true')
    const label = row.querySelector('[data-testid="dispatch-row-undo"]')!
    expect(label.textContent).toBe(STATION_COPY.dispatch.undoButton)
    expect(row.querySelector('.line-through')).toBeTruthy()
  })

  it('Undo re-bumps ready_to_run for that one line and, once it succeeds, the row clears from local memory', async () => {
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(<KitchenScreen lines={fullLines} now={now} connectionState="live" onBump={onBump} />)
    })
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())
    act(() => {
      root.render(<KitchenScreen lines={linesWithoutKl7} now={now} connectionState="live" onBump={onBump} />)
    })

    const undoButton = q('[data-testid="dispatch-row-undo"]')[0] as HTMLButtonElement
    await act(async () => undoButton.click())

    expect(onBump).toHaveBeenCalledWith(['kl-7'], 'ready_to_run')

    // The server still (per this test's static fixture) does not report kl-7 as ready, and the
    // local recoverable-window memory has now been cleared by the successful undo — so the row
    // must be gone entirely, not stuck showing a stale Undo.
    const stillThere = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))
    expect(stillThere).toBeUndefined()
  })

  it('an undo the server refuses leaves the row exactly as it was — struck through, still offering Undo', async () => {
    const onBump = jest.fn(async (lineIds: string[], action: StationBumpAction): Promise<StationBumpOutcome> => {
      if (action === 'ready_to_run') return { ok: false, total: lineIds.length, failedLineIds: lineIds }
      return { ok: true, total: lineIds.length, failedLineIds: [] }
    })
    act(() => {
      root.render(<KitchenScreen lines={fullLines} now={now} connectionState="live" onBump={onBump} />)
    })
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.collectedButton)[0].click())
    act(() => {
      root.render(<KitchenScreen lines={linesWithoutKl7} now={now} connectionState="live" onBump={onBump} />)
    })

    const undoButton = q('[data-testid="dispatch-row-undo"]')[0] as HTMLButtonElement
    await act(async () => undoButton.click())

    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Onion rings'))!
    expect(row.getAttribute('data-collected')).toBe('true')
  })
})

describe('KitchenScreen — per line is the default, per table is a small shortcut over it', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function renderWall(onBump = NO_BUMP) {
    act(() => {
      root.render(<KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  function wallCard(tableLabel: string) {
    return q('[data-testid="active-table-card"]').find((c) => c.textContent?.startsWith(tableLabel))!
  }

  it('gives every line its own button — a salad and a steak do not finish together', () => {
    renderWall()
    const card = wallCard('Table 16')
    const rows = Array.from(card.querySelectorAll('[data-testid="station-line-row"]'))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.cookedButton)
    }
  })

  it('is ONE call carrying exactly the ids that card is showing, not a loop of taps', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderWall(onBump)
    const card = wallCard('Table 16')
    const rowIds = Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) =>
      r.getAttribute('data-line-id'),
    )
    const control = card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement

    await act(async () => control.click())

    expect(onBump).toHaveBeenCalledTimes(1)
    expect(onBump).toHaveBeenCalledWith(rowIds, 'cooked')
  })

  it('is absent on a card holding one line', () => {
    renderWall()
    const single = wallCard('Table 8')
    expect(single.querySelectorAll('[data-testid="station-line-row"]')).toHaveLength(1)
    expect(single.querySelector('[data-testid="per-card-control"]')).toBeNull()
  })

  it('paints a spread of ages in several different colours in the active zone', () => {
    renderWall()
    const active = new Set(q('[data-testid="active-table-card"]').map((c) => c.getAttribute('data-escalation')))
    expect(active.size).toBeGreaterThanOrEqual(3)
  })

  it('reads an absent table as words in the ready zone, never "Table 0"', () => {
    renderWall()
    const ready = container.querySelector('[data-testid="ready-section"]')!
    expect(ready.textContent).toContain('No table')
    expect(ready.textContent).not.toContain('Table 0')
  })

  it('partitions the 12877-minute-old line into OLDER UNRESOLVED instead of the Ready queue', () => {
    // REDESIGN 2026-09-01. 12877 minutes is ~9 days — far past UNRESOLVED_AFTER_MINUTES (12h).
    // It used to sit in the Ready queue as an unbounded MM:SS clock; on production that class of
    // line was 80% of the board AND dragged the density tier down, shrinking live orders.
    // It is MOVED, never hidden: still on the board, in its own collapsed section, state untouched.
    renderWall()
    const inReady = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Beef burger'))
    expect(inReady).toBeUndefined()

    const older = container.querySelector('[data-testid="older-unresolved-section"]')!
    expect(older).toBeTruthy()
    expect(Number(older.getAttribute('data-older-count'))).toBeGreaterThan(0)
    // Collapsed by default — the count is visible without opening it.
    expect(older.getAttribute('data-older-open')).toBe('false')
  })

  it('buys columns with density as the board fills, both surfaces respond independently', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const quietActive = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')
    const quietReady = container.querySelector('[data-testid="ready-section"]')!.getAttribute('data-ready-density')

    renderWall()
    const fullActive = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')
    const fullReady = container.querySelector('[data-testid="ready-section"]')!.getAttribute('data-ready-density')

    expect(quietActive).not.toBe(fullActive)
    expect(quietReady).not.toBe(fullReady)
  })

  it('says so, on the card and on the rows, when only some of what was tapped moved', async () => {
    const refusedIds: string[] = []
    const onBump = jest.fn(async (lineIds: string[]): Promise<StationBumpOutcome> => {
      const failed = lineIds.slice(0, 2)
      refusedIds.push(...failed)
      return { ok: false, total: lineIds.length, failedLineIds: failed }
    })
    renderWall(onBump)
    const card = wallCard('Table 16')
    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())

    const banner = card.querySelector('[data-testid="card-bump-failure"]')!
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('data-failed-count')).toBe('2')
    expect(banner.querySelector('[data-testid="card-bump-failure-count"]')!.textContent).toBe('2/4')

    const marked = Array.from(card.querySelectorAll('[data-testid="station-line-row"][data-failed="true"]'))
    expect(marked.map((r) => r.getAttribute('data-line-id'))).toEqual(refusedIds)
  })
})
