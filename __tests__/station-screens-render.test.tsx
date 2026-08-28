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
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { BarScreen } from '@/components/stations/bar-screen'
import { buildBarFixture, buildKitchenFixture } from '@/lib/stations/dev-fixture'
import { STATION_COPY } from '@/lib/stations/copy'

let container: HTMLDivElement
let root: Root

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

  function renderKitchen() {
    act(() => {
      root.render(
        <KitchenScreen
          lines={buildKitchenFixture(now)}
          now={now}
          connectionState="live"
          onMarkCooked={() => {}}
          onMarkReadyToRun={() => {}}
        />,
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
    const cards = Array.from(container.querySelectorAll('[data-testid="cooked-card"]'))
    expect(cards.map((c) => c.getAttribute('data-escalation'))).toEqual(['red', 'amber', 'white'])
  })

  it('a cooked card carries the Ready to run button, which removes it from the board on success', () => {
    renderKitchen()
    const cards = Array.from(container.querySelectorAll('[data-testid="cooked-card"]'))
    const ribeyeCard = cards.find((c) => c.textContent?.includes('Ribeye'))!
    const button = ribeyeCard.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe(STATION_COPY.kitchen.readyToRunButton)
  })

  it('groups OUTSTANDING by table — a cooked line at the same table does not reappear here', () => {
    renderKitchen()
    const tableGroups = Array.from(container.querySelectorAll('[data-testid="outstanding-table-group"]'))
    expect(tableGroups.length).toBeGreaterThan(0)
    const table4 = tableGroups.find((el) => el.textContent?.includes('Table 4'))
    expect(table4).toBeTruthy()
    expect(table4!.textContent).toContain('Truffle fries')
    expect(table4!.textContent).not.toContain('Ribeye')
  })

  it('an outstanding row carries the Cooked button', () => {
    renderKitchen()
    const rows = Array.from(container.querySelectorAll('[data-testid="outstanding-line-row"]'))
    const friesRow = rows.find((r) => r.textContent?.includes('Truffle fries'))!
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

    const table9 = Array.from(container.querySelectorAll('[data-testid="outstanding-table-group"]')).find((el) =>
      el.textContent?.includes('Table 9'),
    )
    expect(table9!.textContent).not.toContain('Side of mash')
  })

  it('tapping Cooked fires onMarkCooked with the line id', () => {
    const onMarkCooked = jest.fn()
    act(() => {
      root.render(
        <KitchenScreen
          lines={buildKitchenFixture(now)}
          now={now}
          connectionState="live"
          onMarkCooked={onMarkCooked}
          onMarkReadyToRun={() => {}}
        />,
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === STATION_COPY.kitchen.cookedButton,
    ) as HTMLButtonElement
    act(() => button.click())
    // Outstanding is sorted oldest-table-first: kl-5 (table 9, order placed 6 min ago) precedes
    // kl-4 (table 4, order placed 1 min ago), so its Cooked button is first in DOM order.
    expect(onMarkCooked).toHaveBeenCalledWith('kl-5')
  })

  it('tapping Ready to run fires onMarkReadyToRun with the line id', () => {
    const onMarkReadyToRun = jest.fn()
    act(() => {
      root.render(
        <KitchenScreen
          lines={buildKitchenFixture(now)}
          now={now}
          connectionState="live"
          onMarkCooked={() => {}}
          onMarkReadyToRun={onMarkReadyToRun}
        />,
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === STATION_COPY.kitchen.readyToRunButton,
    ) as HTMLButtonElement
    act(() => button.click())
    // kl-3 is the reddest (oldest) cooked card, first in DOM order.
    expect(onMarkReadyToRun).toHaveBeenCalledWith('kl-3')
  })
})

describe('BarScreen renders against seeded data', () => {
  const now = Date.parse('2026-08-27T20:00:00Z')

  function renderBar() {
    act(() => {
      root.render(
        <BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBumpOut={() => {}} />,
      )
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

  it('every IN card carries an Out button', () => {
    renderBar()
    const cards = Array.from(
      container.querySelector('[data-testid="bar-in-section"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.querySelector('button')?.textContent).toBe(STATION_COPY.bar.outButton)
    }
  })

  it('IN cards never escalate colour with age (no red/amber classes)', () => {
    renderBar()
    const card = container.querySelector('[data-testid="bar-round-card"]')!
    expect(card.className).not.toMatch(/amber|red-/)
  })

  it('route_to = unrouted renders under the loud Unrouted heading, not in the IN queue, with no Out button', () => {
    renderBar()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')
    expect(unrouted!.textContent).toContain('Milkshake')
    expect(unrouted!.textContent).toContain(STATION_COPY.unrouted.itemNote)
    expect(unrouted!.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-testid="bar-in-section"]')!.textContent).not.toContain('Milkshake')
  })

  it('tapping Out fires onBumpOut with the round id', () => {
    const onBumpOut = jest.fn()
    act(() => {
      root.render(<BarScreen rounds={buildBarFixture(now)} now={now} connectionState="live" onBumpOut={onBumpOut} />)
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === STATION_COPY.bar.outButton,
    ) as HTMLButtonElement
    act(() => button.click())
    // o-3 (table 2) is the oldest round, first in DOM order.
    expect(onBumpOut).toHaveBeenCalledWith('o-3')
  })
})
