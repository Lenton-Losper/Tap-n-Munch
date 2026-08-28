/**
 * @jest-environment jsdom
 *
 * feat/station-screens-v1 — proves the kitchen and bar screens render against seeded,
 * schema-shaped fixture data (lib/stations/dev-fixture.ts). Mounts the real components with
 * react-dom/client, the same pattern __tests__/350-feed-connection-indicator-renders.test.tsx
 * uses for the same reason: a unit test on the grouping functions alone cannot show the DOM
 * actually reads right.
 *
 * REBUILT 2026-08-28 for the real four-state model: the kitchen screen's escalating zone is now
 * "Cooked — awaiting pass" (state 'cooked'), not "Ready to run" — a line that reaches 'ready'
 * cannot appear on this screen at all any more (see lib/stations/types.ts's docblock), so there
 * is no zone left to represent it, and the bar screen is a single IN queue rather than IN | OUT
 * for the same reason.
 *
 * EXTENDED 2026-08-28 for the wall rebuild. The volume cases live at the bottom of this file and
 * they are the load-bearing ones: what a four-card board does proves nothing about a twenty-card
 * wall, which is the size the layout question only exists at.
 *
 * WHAT THIS FILE CANNOT DO: jsdom has no layout engine, so "twenty cards fit without the container
 * scrolling" is not assertable here — scrollHeight and clientHeight are both zero. That measurement
 * is tests/e2e/station-board-wall-fit.spec.ts's job, in a real browser at 1920x1080. What IS
 * assertable here is everything the layout is DERIVED from: how many colours a full board produces,
 * and that its density responds to load rather than being fixed.
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

/** The screens take ONE bump handler for a line and for a whole table alike — lib/stations/bump.ts. */
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

  it('renders the page and both zones', () => {
    renderKitchen()
    expect(container.querySelector('[data-testid="kitchen-screen"]')).toBeTruthy()
    expect(container.textContent).toContain(STATION_COPY.kitchen.pageTitle)
    expect(container.querySelector('[data-testid="cooked-section"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="outstanding-section"]')).toBeTruthy()
  })

  it('shows all three age-escalation bands in the cooked zone, oldest (reddest) first', () => {
    renderKitchen()
    // Still ONE data-testid="cooked-card" per PLATE, not per table — the pass card groups them by
    // table so the per-table control has somewhere to live, but a plate keeps its own colour.
    expect(q('[data-testid="cooked-card"]').map((c) => c.getAttribute('data-escalation'))).toEqual([
      'red',
      'amber',
      'white',
    ])
  })

  it('a cooked card carries the Ready to run button, which removes it from the board on success', () => {
    renderKitchen()
    const ribeyeCard = q('[data-testid="cooked-card"]').find((c) => c.textContent?.includes('Ribeye'))!
    expect(ribeyeCard.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.readyToRunButton)
  })

  it('groups OUTSTANDING by table — a cooked line at the same table does not reappear here', () => {
    renderKitchen()
    const tableGroups = q('[data-testid="outstanding-table-card"]')
    expect(tableGroups.length).toBeGreaterThan(0)
    const table4 = tableGroups.find((el) => el.textContent?.includes('Table 4'))
    expect(table4).toBeTruthy()
    expect(table4!.textContent).toContain('Truffle fries')
    expect(table4!.textContent).not.toContain('Ribeye')
  })

  it('an outstanding row carries the Cooked button', () => {
    renderKitchen()
    const friesRow = q('[data-testid="station-line-row"]').find((r) => r.textContent?.includes('Truffle fries'))!
    expect(friesRow.querySelector('button')!.textContent).toBe(STATION_COPY.kitchen.cookedButton)
  })

  it('route_to = unrouted renders under the loud Unrouted heading, not inside table 9', () => {
    renderKitchen()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')
    expect(unrouted).toBeTruthy()
    expect(unrouted!.textContent).toContain('Side of mash')
    // Pinned 2026-08-28: every unrouted ITEM carries this, not just the section banner.
    expect(unrouted!.querySelector('[data-testid="unrouted-item"]')?.textContent).toContain(
      STATION_COPY.unrouted.itemNote,
    )

    const table9 = q('[data-testid="outstanding-table-card"]').find((el) => el.textContent?.includes('Table 9'))
    expect(table9!.textContent).not.toContain('Side of mash')
  })

  it('tapping Cooked bumps exactly that one line', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.cookedButton)[0].click())
    // Outstanding is sorted oldest-table-first: kl-5 (table 9, order placed 6 min ago) precedes
    // kl-4 (table 4, order placed 1 min ago), so its Cooked button is first in DOM order.
    expect(onBump).toHaveBeenCalledWith(['kl-5'], 'cooked')
  })

  it('tapping Ready to run bumps exactly that one line', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderKitchen(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.kitchen.readyToRunButton)[0].click())
    // kl-3 is the reddest (oldest) cooked plate, first in DOM order.
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

  it('renders the page and the single IN queue', () => {
    renderBar()
    expect(container.querySelector('[data-testid="bar-screen"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-in-section"]')).toBeTruthy()
  })

  it('IN is FIFO — oldest round first', () => {
    renderBar()
    const inCards = Array.from(
      container.querySelector('[data-testid="bar-in-section"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(inCards[0].textContent).toContain('Table 2')
    expect(inCards[1].textContent).toContain('Table 11')
  })

  it('every drink in an IN round carries its own Out button', () => {
    renderBar()
    const cards = Array.from(
      container.querySelector('[data-testid="bar-in-section"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      const rows = Array.from(card.querySelectorAll('[data-testid="station-line-row"]'))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.querySelector('button')!.textContent).toBe(STATION_COPY.bar.outButton)
      }
    }
  })

  it('IN cards never escalate colour with age — the standing bar ruling, unchanged', () => {
    renderBar()
    const card = container.querySelector('[data-testid="bar-round-card"]')!
    expect(card.className).not.toMatch(/amber|red-/)
    expect(card.getAttribute('data-escalation')).toBe('none')
  })

  it('route_to = unrouted renders under the loud Unrouted heading, not in the IN queue, with no Out button', () => {
    renderBar()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')!
    expect(unrouted.textContent).toContain('Milkshake')
    expect(unrouted.textContent).toContain(STATION_COPY.unrouted.itemNote)
    expect(unrouted.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-testid="bar-in-section"]')!.textContent).not.toContain('Milkshake')
  })

  it('tapping Out bumps ONE drink, by line id — a round is not poured all at once', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderBar(onBump)
    await act(async () => buttonsLabelled(STATION_COPY.bar.outButton)[0].click())
    // o-3 (table 2) is the oldest round and holds exactly one line, bl-1.
    expect(onBump).toHaveBeenCalledWith(['bl-1'], 'out')
  })
})

/**
 * ============================================================================================
 * THE VOLUME CASES. TWENTY TABLES, WHICH IS THE ONLY SIZE THE LAYOUT QUESTION EXISTS AT.
 * ============================================================================================
 */
describe('the kitchen board at twenty tables', () => {
  const now = Date.parse('2026-08-28T18:30:00.000Z')

  function renderWall(onBump = NO_BUMP) {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={onBump} />,
      )
    })
  }

  it('really does put twenty table cards on the board', () => {
    renderWall()
    const cards = q('[data-testid="pass-table-card"]').length + q('[data-testid="outstanding-table-card"]').length
    expect(cards).toBe(20)
    expect(container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-card-count')).toBe('20')
  })

  /**
   * THE LOAD-BEARING COLOUR TEST, and the reason it is written as a SET and not as a list of
   * expected colours.
   *
   * "The 88-minute card is red" passes identically whether the escalation discriminates or paints
   * everything red, which is the failure the owner actually reported. The property that separates a
   * working board from a broken one is that a spread of ages across a FULL board produces several
   * different colours — if a cook cannot tell two cards apart, the colour is carrying nothing.
   *
   * EACH ZONE IS ASSERTED SEPARATELY, and that is not tidiness — the first version of this test
   * looked at every card on the board at once and PASSED with outstandingEscalation replaced by a
   * constant `return 'red'`, because the pass zone's own four tiers still filled the set. A board
   * where every outstanding table is red is exactly the defect, and the whole-board assertion could
   * not see it. The two zones run on two different clocks and two different band sets, so each has
   * to discriminate on its own.
   *
   * Made to fail on purpose before being committed: `outstandingEscalation` replaced with a constant
   * `return 'red'` collapsed the outstanding set to one member and failed the second expectation
   * below; the same done to `readyToRunEscalation` failed the first.
   */
  it('paints a spread of ages in several different colours in BOTH zones, not one wall of red', () => {
    renderWall()
    const pass = new Set(q('[data-testid="pass-table-card"]').map((c) => c.getAttribute('data-escalation')))
    const outstanding = new Set(
      q('[data-testid="outstanding-table-card"]').map((c) => c.getAttribute('data-escalation')),
    )

    expect(pass.size).toBeGreaterThanOrEqual(3)
    expect(outstanding.size).toBeGreaterThanOrEqual(3)
    // And every one of the four tiers is reachable from a realistic board, not just three of them.
    expect(new Set([...pass, ...outstanding])).toEqual(new Set(['white', 'amber', 'red', 'stale']))
  })

  /**
   * Density is a FUNCTION OF LOAD, which is the whole resolution of the density-vs-legibility
   * tension. A fixed grid — which is what was there before — reads identically at four cards and at
   * twenty, so this asserts the two differ rather than asserting either one's value.
   */
  it('spends the wall on size when quiet and buys columns with type size when full', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const quiet = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')

    renderWall()
    const full = container.querySelector('[data-testid="kitchen-screen"]')!.getAttribute('data-density')

    expect(quiet).toBe('roomy')
    expect(full).toBe('compact')
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
    const table6 = q('[data-testid="outstanding-table-card"]').find((c) => c.textContent?.includes('Table 6'))!
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
    const card = wallCard('outstanding-table-card', 'Table 16')
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
    const card = wallCard('outstanding-table-card', 'Table 16')
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
    const card = wallCard('outstanding-table-card', 'Table 16')
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

  /**
   * A single-line card does NOT get one, on purpose: the per-line button there already IS the one
   * tap, and a second identical-looking control beside it only raises the question of whether the
   * two do different things.
   */
  it('is absent on a card holding one line, where it would only be a second way to do the same tap', () => {
    act(() => {
      root.render(
        <KitchenScreen lines={buildKitchenWallFixture(now)} now={now} connectionState="live" onBump={NO_BUMP} />,
      )
    })
    const single = wallCard('outstanding-table-card', 'Table 8')
    expect(single.querySelectorAll('[data-testid="station-line-row"]')).toHaveLength(1)
    expect(single.querySelector('[data-testid="per-card-control"]')).toBeNull()

    const multi = wallCard('outstanding-table-card', 'Table 16')
    expect(multi.querySelector('[data-testid="per-card-control"]')).toBeTruthy()
  })

  /**
   * THREE OF FIVE. The card does not roll back, does not retry and does not go quiet: it marks the
   * rows that would not move and puts the count on the card, and both stay until those lines leave
   * the board. Without this the card would simply shrink and read exactly like a table where the
   * rest is still being cooked.
   *
   * Made to fail on purpose: stopping the card from carrying `outcome.failedLineIds` into its own
   * state — i.e. the card treating a refusal as a success — left zero marked rows and no banner at
   * all, and this failed on the banner before it even reached the rows.
   */
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
    const card = wallCard('outstanding-table-card', 'Table 16')
    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())

    const banner = card.querySelector('[data-testid="card-bump-failure"]')!
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('data-failed-count')).toBe('2')
    expect(banner.querySelector('[data-testid="card-bump-failure-count"]')!.textContent).toBe('2/4')

    const marked = Array.from(card.querySelectorAll('[data-testid="station-line-row"][data-failed="true"]'))
    expect(marked.map((r) => r.getAttribute('data-line-id'))).toEqual(refusedIds)
    // And the two that DID move are not accused of anything.
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

  it('tiles twenty rounds at the same density the kitchen would', () => {
    renderWall()
    expect(q('[data-testid="bar-round-card"]')).toHaveLength(20)
    expect(container.querySelector('[data-testid="bar-screen"]')!.getAttribute('data-density')).toBe('compact')
  })

  /**
   * THE RULING, PINNED. "A warm beer is a smaller problem than a cold steak" — bar age is
   * display-only. The tiling rebuild shares every other decision with the kitchen board, so this is
   * the one place the two boards deliberately differ, and it must not drift by accident.
   *
   * The fixture spans seconds to 12877 minutes precisely so that a board which HAD started
   * escalating would fail here.
   */
  it('still carries no age escalation at any age, across the whole spread', () => {
    renderWall()
    const escalations = new Set(q('[data-testid="bar-round-card"]').map((c) => c.getAttribute('data-escalation')))
    expect(escalations).toEqual(new Set(['none']))
  })

  it('shows the age itself in readable units, including the multi-day one', () => {
    renderWall()
    expect(container.textContent).toContain('8d')
    expect(container.textContent).not.toContain('12877')
    expect(container.textContent).toContain('No table')
  })

  it('carries a per-round shortcut over the same per-line ids, exactly like the kitchen', async () => {
    const onBump = jest.fn(NO_BUMP)
    renderWall(onBump)
    // Table 4 is the four-drink round.
    const card = q('[data-testid="bar-round-card"]').find((c) => c.textContent?.startsWith('Table 4'))!
    const rowIds = Array.from(card.querySelectorAll('[data-testid="station-line-row"]')).map((r) =>
      r.getAttribute('data-line-id'),
    )
    expect(rowIds).toHaveLength(4)

    await act(async () => (card.querySelector('[data-testid="per-card-control"] button') as HTMLButtonElement).click())
    expect(onBump).toHaveBeenCalledTimes(1)
    expect(onBump).toHaveBeenCalledWith(rowIds, 'out')
  })
})
