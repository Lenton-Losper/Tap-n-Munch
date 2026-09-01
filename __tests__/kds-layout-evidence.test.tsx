/**
 * @jest-environment jsdom
 *
 * RENDER EVIDENCE at 1 / 5 / 10 / 20 / 20+ active cards.
 *
 * Not a behavioural test — a measurement. It renders the real KitchenScreen at each volume and
 * prints what the board actually resolves to, so the density ladder and the "stop shrinking"
 * floor can be read off a run rather than inferred from the source. The assertions are the ones
 * worth failing on; the console output is the deliverable.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import type { KitchenLine } from '@/lib/stations/types'

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

function activeCards(n: number): KitchenLine[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `l${i}`, orderId: `o${i}`, tableNumber: String(i + 1), orderNumber: i + 1,
    itemName: `Item ${i + 1}`, quantity: (i % 3) + 1, lineNote: i === 0 ? 'NO NUTS' : null,
    routeTo: 'kitchen' as const, state: 'outstanding' as const,
    placedAt: minsAgo(2 + i), cookedAt: null, readyAt: null,
    unrouted: false, sharedWithOtherStation: false,
  }))
}

function measure(label: string, lines: KitchenLine[]) {
  act(() => {
    root.render(<KitchenScreen lines={lines} now={NOW} connectionState="live" onBump={NO_BUMP} />)
  })
  const screen = container.querySelector('[data-testid="kitchen-screen"]')!
  const grid = container.querySelector('[data-testid="active-grid"]')
  const ready = container.querySelector('[data-testid="ready-section"]')!
  const cards = container.querySelectorAll('[data-testid="active-table-card"]').length
  const itemEl = container.querySelector('[data-testid="station-line-row"] p')
  const out = {
    label,
    cards,
    density: screen.getAttribute('data-density'),
    gridCols: (grid?.className.match(/grid-cols-\d+(?:\s+xl:grid-cols-\d+)?/g) ?? []).join(' '),
    gridOverflow: (grid?.className.match(/overflow-[xy]-\w+/g) ?? []).join(' '),
    horizontalOverflowPossible: /(^|\s)columns-\d/.test(grid?.className ?? '') ? 'YES — BUG' : 'no',
    itemFont: (itemEl?.className.match(/text-\w+/) ?? [''])[0],
    readyCollapsed: ready.getAttribute('data-ready-collapsed'),
    readyCount: ready.getAttribute('data-ready-count'),
  }
  console.log(
    `${String(out.label).padEnd(10)} cards=${String(out.cards).padEnd(4)} density=${String(out.density).padEnd(9)} ` +
      `cols=${out.gridCols.padEnd(28)} item=${out.itemFont.padEnd(9)} overflow=${out.gridOverflow.padEnd(34)} ` +
      `h-scroll=${out.horizontalOverflowPossible.padEnd(9)} ready=${out.readyCollapsed === 'true' ? 'collapsed' : 'expanded'}(${out.readyCount})`,
  )
  return out
}

describe('rendered layout at each volume', () => {
  it('measures 1, 5, 10, 20 and 20+ active cards', () => {
    const rows = [
      measure('1 order', activeCards(1)),
      measure('5 orders', activeCards(5)),
      measure('10 orders', activeCards(10)),
      measure('20 orders', activeCards(20)),
      measure('40 orders', activeCards(40)),
    ]

    expect(rows.map((r) => r.density)).toEqual(['roomy', 'standard', 'compact', 'dense', 'dense'])

    // The floor: 20 and 40 resolve identically. Nothing shrinks further.
    expect(rows[4].itemFont).toBe(rows[3].itemFont)
    expect(rows[4].gridCols).toBe(rows[3].gridCols)

    // Item name never drops below the 24px readability floor at any volume.
    for (const r of rows) expect(r.itemFont).toBe('text-2xl')

    // No volume can produce a sideways board.
    for (const r of rows) {
      expect(r.horizontalOverflowPossible).toBe('no')
      expect(r.gridOverflow).toContain('overflow-x-hidden')
      expect(r.gridOverflow).toContain('overflow-y-auto')
    }

    // Ready is collapsed throughout — none of these fixtures has a ready line.
    for (const r of rows) expect(r.readyCollapsed).toBe('true')
  })

  it('measures Ready expanding, and the 12h partition holding cards back', () => {
    const withReady: KitchenLine[] = [
      ...activeCards(3),
      { ...activeCards(1)[0], id: 'r1', tableNumber: '9', itemName: 'Cheese toast', quantity: 2,
        state: 'ready', readyAt: minsAgo(6), lineNote: null },
    ]
    const r1 = measure('3+1 ready', withReady)
    expect(r1.readyCollapsed).toBe('false')
    expect(r1.readyCount).toBe('1')
    expect(r1.density).toBe('roomy')

    const withStale: KitchenLine[] = [
      ...activeCards(3),
      ...activeCards(12).map((l, i) => ({
        ...l, id: `s${i}`, tableNumber: `9${i}`, placedAt: minsAgo(13 * 60),
      })),
    ]
    const r2 = measure('3+12 stale', withStale)
    const older = container.querySelector('[data-testid="older-unresolved-section"]')!
    console.log(
      `${'older'.padEnd(10)} partitioned=${older.getAttribute('data-older-count')} ` +
        `open=${older.getAttribute('data-older-open')}  -> active density stays ${r2.density}`,
    )
    // The compounding harm is gone: 12 dead cards no longer drag the live three out of roomy.
    expect(r2.cards).toBe(3)
    expect(r2.density).toBe('roomy')
    expect(older.getAttribute('data-older-count')).toBe('12')
    expect(older.getAttribute('data-older-open')).toBe('false')
  })
})
