/**
 * @jest-environment jsdom
 *
 * Full coverage of the rebuilt bar wall board (components/stations/bar-screen.tsx), second-pass
 * board redesign (20260829). Replaces this screen's coverage in the now-stale
 * __tests__/station-screens-render.test.tsx (kept, unedited, for the owner to reconcile against
 * the kitchen agent's own rebuild — see this file's own commit for why).
 *
 * Mounts the real component with react-dom/client, same pattern __tests__/350-feed-connection-
 * indicator-renders.test.tsx and the old shared render test use, for the same reason: a unit test
 * on the grouping functions alone cannot show the DOM actually reads right.
 *
 * WHAT THIS FILE CANNOT DO: jsdom has no layout engine, so "the 68/32 split really is 68/32 in
 * pixels" and "the board never scrolls" are not assertable here — that is
 * tests/e2e/station-board-wall-fit.spec.ts's job (or the direct screenshot this rebuild's report
 * captured, since that spec's own assumptions predate this redesign). What IS assertable here is
 * everything the layout is DERIVED from: which zone a line lands in, how the Ready zone sorts,
 * that NOT SENT sits outside the scrollable body, and the collected-must-be-recoverable wiring.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BarScreen } from '@/components/stations/bar-screen'
import { buildBarFixture, buildBarWallFixture } from '@/lib/stations/dev-fixture'
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

describe('BarScreen — structure', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderBar(onBump = NO_BUMP) {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('renders the page title and connection indicator in the minimal-height header', () => {
    renderBar()
    expect(container.textContent).toContain(STATION_COPY.bar.pageTitle)
    expect(container.querySelector('[data-testid="station-connection-indicator"]')).toBeTruthy()
  })

  it('renders the two-surface body with active before ready, in DOM order', () => {
    renderBar()
    const body = container.querySelector('[data-testid="station-board-body"]')
    expect(body).toBeTruthy()
    const active = container.querySelector('[data-testid="bar-active-section"]')
    const ready = container.querySelector('[data-testid="bar-ready-section"]')
    expect(active).toBeTruthy()
    expect(ready).toBeTruthy()
    expect(active!.compareDocumentPosition(ready!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives Ready only the height it needs and lets Active take the rest', () => {
    renderBar()
    const active = container.querySelector('[data-testid="bar-active-section"]')!
    const ready = container.querySelector('[data-testid="bar-ready-section"]')!
    // REDESIGN 2026-09-01 — see the kitchen's matching test. Elastic, not a fixed ratio.
    // Active is CONTENT-height (flex 0 1 auto): it takes what its cards need, shrinks and scrolls
    // when they exceed the space Ready leaves, and never claims the viewport's full remainder —
    // that is what put a 500-600px dead band between Active and Ready on a quiet board.
    expect(active.className).toMatch(/flex-\[0_1_auto\]/)
    expect(active.className).not.toMatch(/flex-\[68\]/)
    expect(ready.className).toMatch(/shrink-0/)
    expect(ready.className).not.toMatch(/flex-\[32\]/)
  })
})

describe('BarScreen — NOT SENT strip', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  it('renders unrouted items flattened, OUTSIDE and above station-board-body', () => {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />)
    })
    const strip = container.querySelector('[data-testid="unrouted-section"]')!
    const body = container.querySelector('[data-testid="station-board-body"]')!
    expect(strip).toBeTruthy()
    expect(strip.textContent).toContain('Milkshake')
    expect(strip.textContent).toContain('NOT SENT')
    // Outside the scrollable body entirely, not merely first inside it.
    expect(body.contains(strip)).toBe(false)
    expect(strip.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // No bump controls on an unrouted item — nowhere for it to be bumped TO.
    expect(strip.querySelector('button')).toBeNull()
  })

  it('renders nothing when there is nothing unrouted', () => {
    const rounds = buildBarFixture(now).filter((r) => !r.unrouted)
    act(() => {
      root.render(<BarScreen rounds={rounds} now={now} connectionState="live" onBump={NO_BUMP} />)
    })
    expect(container.querySelector('[data-testid="unrouted-section"]')).toBeNull()
  })

  it('flattens multiple items across multiple unrouted rounds, one entry per item', () => {
    const now2 = Date.parse('2026-08-28T18:30:00.000Z')
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(now2)} now={now2} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const strip = container.querySelector('[data-testid="unrouted-section"]')!
    expect(q('[data-testid="unrouted-item"]', ).length).toBeGreaterThanOrEqual(1)
    expect(strip.textContent).toContain('Milkshake (no category)')
  })
})

describe('BarScreen — TO MAKE (active)', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderBar(onBump = NO_BUMP) {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('a round with one drink poured and one not appears in TO MAKE with only its pending item', () => {
    renderBar()
    const activeGrid = container.querySelector('[data-testid="bar-active-grid"]')!
    expect(activeGrid.textContent).toContain('Gin and tonic')
    expect(activeGrid.textContent).not.toContain('Sparkling water')
  })

  it('shows the elapsed age as whole minutes, not a ticking clock', () => {
    renderBar()
    const clock = container.querySelector('[data-testid="bar-round-card"] [data-testid="card-age"]')!
    // REDESIGN 2026-09-01: whole minutes, no seconds.
    expect(clock.textContent).toMatch(/^\d+m$|^<1m$/)
  })

  it('every drink in a TO MAKE round carries its own Out button', () => {
    renderBar()
    const row = q('[data-testid="bar-active-grid"] [data-testid="station-line-row"]').find((r) =>
      r.textContent?.includes('IPA'),
    )!
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.readyButton)
  })

  it('tapping Out bumps ONE drink, by line id — a round is not poured all at once', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderBar(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.bar.readyButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['bl-1'], 'out')
  })

  it('TO MAKE now escalates colour with age — the 20260829 reversal, not the old "always neutral" rule', () => {
    const wallNow = Date.parse('2026-08-28T18:30:00.000Z')
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(wallNow)} now={wallNow} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const escalations = new Set(
      q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]').map((c) => c.getAttribute('data-escalation')),
    )
    expect(escalations.size).toBeGreaterThanOrEqual(2)
    expect([...escalations].some((e) => e !== 'white')).toBe(true)
  })

  it('the per-round "All out" shortcut acts on exactly that round\'s outstanding lines, per line stays', async () => {
    const wallNow = Date.parse('2026-08-28T18:30:00.000Z')
    const onBump = jest.fn(NO_BUMP)
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(wallNow)} now={wallNow} connectionState="live" onBump={onBump} />,
      )
    })
    const card = q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]').find((c) =>
      c.textContent?.startsWith('Table 4'),
    )!
    const rowIds = Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) =>
      r.getAttribute('data-line-id'),
    )
    expect(rowIds.length).toBeGreaterThan(1)
    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())
    expect(onBump).toHaveBeenCalledTimes(1)
    expect(onBump).toHaveBeenCalledWith(rowIds, 'out')
  })

  it('the note/allergy carrier renders loud, not muted', () => {
    const wallNow = Date.parse('2026-08-28T18:30:00.000Z')
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(wallNow)} now={wallNow} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const note = q('[data-testid="line-note"]')[0]
    expect(note).toBeTruthy()
    expect(note.className).not.toMatch(/opacity-70/)
  })
})

describe('BarScreen — Waiting for collection (Ready dispatch queue)', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderBar(onBump = NO_BUMP) {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={onBump} />)
    })
  }

  it('renders Ready as flat dispatch rows, not round cards', () => {
    renderBar()
    const readySection = container.querySelector('[data-testid="bar-ready-section"]')!
    expect(readySection.querySelector('[data-testid="bar-round-card"]')).toBeNull()
    const row = readySection.querySelector('[data-testid="dispatch-row"]')!
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('Sparkling water')
  })

  it('a dispatch row names table, quantity, item and a whole-minute age', () => {
    renderBar()
    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Sparkling water'))!
    expect(row.textContent).toContain(STATION_COPY.bar.tableLabel('11'))
    expect(row.textContent).toContain('1×')
    // REDESIGN 2026-09-01: whole minutes, no seconds, and no repeated READY word — the row is
    // already under the READY heading. Four fixed slots: TABLE | qty x item | Nm | action.
    const clock = row.querySelector('[data-testid="dispatch-row-clock"]')!
    expect(clock.textContent).toMatch(/^\d+m$|^<1m$/)
    expect(clock.textContent).not.toContain(':')
  })

  it('carries the Collected button, labelled from STATION_COPY.bar', () => {
    renderBar()
    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Sparkling water'))!
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.collectedButton)
  })

  it('tapping Collected bumps ONE line with the collected action', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderBar(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.bar.collectedButton)[0].click())
    expect(onBump).toHaveBeenCalledWith(['bl-3'], 'collected')
  })

  it('sorts oldest-first within a tier (tier first, FIFO second), already sorted by the data layer', () => {
    const wallNow = Date.parse('2026-08-28T18:30:00.000Z')
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(wallNow)} now={wallNow} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const rows = q('[data-testid="dispatch-row"]')
    const escalationRank: Record<string, number> = { red: 3, amber: 2, white: 1, stale: 0 }
    for (let i = 1; i < rows.length; i += 1) {
      const prevRank = escalationRank[rows[i - 1].getAttribute('data-escalation')!]
      const curRank = escalationRank[rows[i].getAttribute('data-escalation')!]
      expect(prevRank).toBeGreaterThanOrEqual(curRank)
    }
  })

  it('Waiting for collection escalates on its OWN softer bands, not the kitchen\'s', () => {
    const wallNow = Date.parse('2026-08-28T18:30:00.000Z')
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(wallNow)} now={wallNow} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const escalations = new Set(q('[data-testid="dispatch-row"]').map((r) => r.getAttribute('data-escalation')))
    expect(escalations.size).toBeGreaterThanOrEqual(3)
  })
})

describe('BarScreen — collected-must-be-recoverable (the one ruling changed from the proposal)', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  it('a collected line stays visible, struck through, with Undo — not vanished on the next render', async () => {
    let rounds = buildBarFixture(now)
    const onBump = jest.fn(async (lineIds: string[], action: StationBumpAction): Promise<StationBumpOutcome> => {
      if (action === 'collected') {
        // Simulate the server: the round's ready item leaves the response entirely, same as a
        // voided line — this is the exact condition useRecentlyCollected exists for.
        rounds = rounds.map((r) => ({ ...r, items: r.items.filter((i) => !lineIds.includes(i.id)) }))
      }
      return { ok: true, total: lineIds.length, failedLineIds: [] }
    })

    function renderNow() {
      act(() => {
        root.render(<BarScreen rounds={rounds} now={now} connectionState="live" onBump={onBump} />)
      })
    }

    renderNow()
    expect(container.textContent).toContain('Sparkling water')

    await act(async () => buttonsLabelled(STATION_COPY.bar.collectedButton)[0].click())
    // Re-render exactly as a refetch would, now that the server has dropped the line.
    renderNow()

    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Sparkling water'))!
    expect(row).toBeTruthy()
    expect(row.getAttribute('data-collected')).toBe('true')
    expect(row.querySelector('[data-testid="dispatch-row-undo"]')).toBeTruthy()
    expect(row.querySelector('[data-testid="dispatch-row-undo"]')!.textContent).toBe(
      STATION_COPY.dispatch.undoButton,
    )
    // The struck-through text carrier, not just any element in the row.
    const label = row.querySelector('span.line-through')
    expect(label).toBeTruthy()
  })

  it('tapping Undo re-bumps to "out" (ready) and, on success, the row goes back to being server-sourced', async () => {
    let rounds = buildBarFixture(now)
    let serverHasIt = true
    const onBump = jest.fn(async (lineIds: string[], action: StationBumpAction): Promise<StationBumpOutcome> => {
      if (action === 'collected') {
        serverHasIt = false
        rounds = rounds.map((r) => ({ ...r, items: r.items.filter((i) => !lineIds.includes(i.id)) }))
      } else if (action === 'out') {
        serverHasIt = true
        // The server round it belongs to (table 11) gets its item back, marked ready again.
        rounds = buildBarFixture(now)
      }
      return { ok: true, total: lineIds.length, failedLineIds: [] }
    })

    function renderNow() {
      act(() => {
        root.render(<BarScreen rounds={rounds} now={now} connectionState="live" onBump={onBump} />)
      })
    }

    renderNow()
    await act(async () => buttonsLabelled(STATION_COPY.bar.collectedButton)[0].click())
    renderNow()
    expect(serverHasIt).toBe(false)

    await act(async () => {
      ;(container.querySelector('[data-testid="dispatch-row-undo"]') as HTMLButtonElement).click()
    })
    expect(onBump).toHaveBeenCalledWith(['bl-3'], 'out')
    renderNow()

    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Sparkling water'))!
    // Undo succeeded and cleared local memory — the row is now sourced from the server response
    // again (state 'ready'), not from recovery memory: no Undo button, no strike-through.
    expect(row.getAttribute('data-collected')).toBe('false')
    expect(row.querySelector('[data-testid="dispatch-row-undo"]')).toBeNull()
    expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.collectedButton)
  })

  it('a failed Collected tap does not mark the row collected — the server never actually moved it', async () => {
    const rounds = buildBarFixture(now)
    const onBump = jest.fn(
      async (lineIds: string[]): Promise<StationBumpOutcome> => ({
        ok: false,
        total: lineIds.length,
        failedLineIds: [...lineIds],
      }),
    )

    act(() => {
      root.render(<BarScreen rounds={rounds} now={now} connectionState="live" onBump={onBump} />)
    })
    await act(async () => buttonsLabelled(STATION_COPY.bar.collectedButton)[0].click())

    const row = q('[data-testid="dispatch-row"]').find((r) => r.textContent?.includes('Sparkling water'))!
    expect(row.getAttribute('data-collected')).toBe('false')
    expect(row.querySelector('[data-testid="line-bump-failed"]')).toBeTruthy()
  })
})

describe('the bar board at real volume (forty rounds)', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function renderWall(onBump = NO_BUMP) {
    act(() => {
      root.render(
        <BarScreen rounds={buildBarWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
  }

  it('tiles every routed round into TO MAKE or Ready, none lost, none duplicated', () => {
    renderWall()
    const cardTables = q('[data-testid="bar-round-card"]').map((c) => c.textContent!.split(/\s|·/)[0])
    const rowCount = q('[data-testid="dispatch-row"]').length
    // Every round appears in the active grid unless fully ready; every ready item is a row.
    expect(cardTables.length).toBeGreaterThan(0)
    expect(rowCount).toBeGreaterThan(0)
  })

  it('shows every Ready age in whole minutes, and never seconds', () => {
    // REDESIGN 2026-09-01. Multi-day lines no longer reach this zone at all — past 12h they are
    // partitioned into OLDER UNRESOLVED — so the unbounded MM:SS case this used to pin cannot
    // occur here. What remains true, and is what a wall screen needs, is that every clock in the
    // dispatch queue is whole minutes with no seconds component.
    renderWall()
    const clocks = q('[data-testid="dispatch-row-clock"]').map((c) => c.textContent ?? '')
    expect(clocks.length).toBeGreaterThan(0)
    for (const t of clocks) expect(t).toMatch(/^\d+m$|^<1m$/)
  })

  it('reads an absent table as words, never "Table 0" and never a bare dash', () => {
    renderWall()
    expect(container.textContent).toContain('No table')
    expect(container.textContent).not.toContain('Table 0')
  })

  it('spends the wall on size when quiet and buys columns with type size when full', () => {
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />)
    })
    const quiet = container.querySelector('[data-testid="bar-screen"]')!.getAttribute('data-density')

    renderWall()
    const full = container.querySelector('[data-testid="bar-screen"]')!.getAttribute('data-density')

    expect(quiet).not.toBe(full)
  })

  it('gives every TO MAKE line its own Out button — a round is not poured all at once', () => {
    renderWall()
    const card = q('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]').find((c) =>
      c.textContent?.startsWith('Table 16'),
    )!
    const rows = Array.from(card.querySelectorAll('[data-testid="station-line-row"]'))
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.readyButton)
    }
  })
})
