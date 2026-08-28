/**
 * @jest-environment jsdom
 *
 * feat/station-screens-v1 — proves the kitchen and bar screens render against seeded,
 * schema-shaped fixture data (lib/stations/dev-fixture.ts), since order_lines /
 * order_line_events have not been relayed yet and there is no live data to render against.
 * Mounts the real components with react-dom/client, the same pattern
 * __tests__/350-feed-connection-indicator-renders.test.tsx uses for the same reason: a unit
 * test on the grouping functions alone cannot show the DOM actually reads right.
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
    expect(container.querySelector('[data-testid="ready-to-run-section"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="outstanding-section"]')).toBeTruthy()
  })

  it('shows all three age-escalation bands in READY TO RUN, oldest (reddest) first', () => {
    renderKitchen()
    const cards = Array.from(container.querySelectorAll('[data-testid="ready-to-run-card"]'))
    expect(cards.map((c) => c.getAttribute('data-escalation'))).toEqual(['red', 'amber', 'white'])
  })

  it('groups OUTSTANDING by table, then station', () => {
    renderKitchen()
    const tableGroups = Array.from(container.querySelectorAll('[data-testid="outstanding-table-group"]'))
    expect(tableGroups.length).toBeGreaterThan(0)
    // Table 4 has one outstanding line (truffle fries) alongside its ready-to-run ribeye, which
    // must NOT reappear here.
    const table4 = tableGroups.find((el) => el.textContent?.includes('Table 4'))
    expect(table4).toBeTruthy()
    expect(table4!.textContent).toContain('Truffle fries')
    expect(table4!.textContent).not.toContain('Ribeye')
  })

  it('a cooked line shows the Ready to run button, not Cooked again', () => {
    renderKitchen()
    const rows = Array.from(container.querySelectorAll('[data-testid="outstanding-line-row"]'))
    const cookedRow = rows.find((r) => r.textContent?.includes('Grilled chicken'))
    expect(cookedRow?.getAttribute('data-status')).toBe('cooked')
    expect(cookedRow?.textContent).toContain(STATION_COPY.kitchen.readyToRunButton)
  })

  it('route_to = null renders under the loud Unrouted heading, not inside table 9', () => {
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
    expect(onMarkCooked).toHaveBeenCalledWith('kl-4')
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

  it('renders the page and both columns', () => {
    renderBar()
    expect(container.querySelector('[data-testid="bar-screen"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-in-column"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-out-column"]')).toBeTruthy()
  })

  it('IN is FIFO — oldest round first', () => {
    renderBar()
    const inCards = Array.from(
      container.querySelector('[data-testid="bar-in-column"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(inCards[0].textContent).toContain('Table 2')
    expect(inCards[1].textContent).toContain('Table 11')
  })

  it('an already-out round appears in OUT with no Out button', () => {
    renderBar()
    const outCards = Array.from(
      container.querySelector('[data-testid="bar-out-column"]')!.querySelectorAll('[data-testid="bar-round-card"]'),
    )
    expect(outCards).toHaveLength(1)
    expect(outCards[0].textContent).toContain('Table 5')
    expect(outCards[0].querySelector('button')).toBeNull()
  })

  it('IN cards never escalate colour with age (no red/amber classes)', () => {
    renderBar()
    const card = container.querySelector('[data-testid="bar-round-card"]')!
    expect(card.className).not.toMatch(/amber|red-/)
  })

  it('route_to = null renders under the loud Unrouted heading, not in IN or OUT', () => {
    renderBar()
    const unrouted = container.querySelector('[data-testid="unrouted-section"]')
    expect(unrouted!.textContent).toContain('Milkshake')
    expect(unrouted!.textContent).toContain(STATION_COPY.unrouted.itemNote)
    expect(container.querySelector('[data-testid="bar-in-column"]')!.textContent).not.toContain('Milkshake')
    expect(container.querySelector('[data-testid="bar-out-column"]')!.textContent).not.toContain('Milkshake')
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
    expect(onBumpOut).toHaveBeenCalledWith('br-1')
  })
})
