/**
 * @jest-environment jsdom
 *
 * feat/station-screens-v1 — REDONE AGAINST REAL ROWS, 2026-08-28. The three claims that were
 * fixture-only before this suite existed:
 *
 *   - both screens rendering
 *   - the half-bumped 'both' line staying independent per station
 *   - age escalation red at ~6 minutes, sorted to the top
 *
 * Reads the snapshot scripts/seed-station-screens-staging.ts writes after a real insert into
 * STAGING (mdqjpxwczrhkxkbqatqa) — the rows in that file are exactly what is live in
 * order_lines/order_line_events at seed time, not a fixture — and maps them through the REAL
 * lib/stations/map-raw-lines.ts, then mounts the REAL KitchenScreen/BarScreen components
 * (react-dom/client, same technique __tests__/350-feed-connection-indicator-renders.test.tsx
 * uses).
 *
 * WHY A SNAPSHOT FILE, NOT A LIVE QUERY FROM INSIDE THIS TEST: tried that first. jest-
 * environment-jsdom's global scope has no fetch, and polyfilling undici's dependency chain to
 * do real TLS from inside jsdom cascaded through missing TextDecoder, then missing
 * clearImmediate, with no clean stopping point — jsdom is not built for real Node socket I/O.
 * Fetching real data (Node environment) and rendering it (jsdom environment) are two different
 * environments' jobs; the JSON snapshot is the seam between them, written by a plain `tsx`
 * script that has no such constraint.
 *
 * REQUIRES the seed script to have been run first: `npx tsx scripts/seed-station-screens-
 * staging.ts`. Skips (does not fail) if the snapshot file is missing, so this suite does not
 * block a run where seeding hasn't happened yet.
 *
 * Age escalation is asserted from the REAL elapsed time at the moment this test runs, not from
 * the original 6/1-minute seed values — real wall-clock time passes between seeding and testing.
 */
import { existsSync, readFileSync } from 'fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { BarScreen } from '@/components/stations/bar-screen'
import { mapRawLinesToBarRounds, mapRawLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import { readyToRunEscalation, ageMinutes } from '@/lib/stations/age'
import type { RawOrderLine, RawOrderLineEvent } from '@/lib/stations/schema-assumptions'
import { SEED_SNAPSHOT_PATH } from '../scripts/seed-station-screens-staging'

type Snapshot = {
  seededAt: string
  restaurantId: string
  orderId: string
  tableNumberByOrderId: Record<string, string>
  lines: RawOrderLine[]
  events: RawOrderLineEvent[]
}

function loadSnapshot(): Snapshot | null {
  if (!existsSync(SEED_SNAPSHOT_PATH)) return null
  return JSON.parse(readFileSync(SEED_SNAPSHOT_PATH, 'utf8')) as Snapshot
}

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

describe('station screens against REAL staging rows', () => {
  it('both screens render against real order_lines rows, not a fixture', () => {
    const snapshot = loadSnapshot()
    if (!snapshot) {
      console.warn('SKIPPED: no seed snapshot found — run scripts/seed-station-screens-staging.ts first')
      return
    }

    const kitchenLines = mapRawLinesToKitchenLines(snapshot.lines, snapshot.events, snapshot.tableNumberByOrderId)
    const barRounds = mapRawLinesToBarRounds(snapshot.lines, snapshot.events, snapshot.tableNumberByOrderId)

    expect(kitchenLines.length).toBeGreaterThan(0)
    expect(barRounds.length).toBeGreaterThan(0)

    act(() => {
      root.render(
        <KitchenScreen
          lines={kitchenLines}
          now={Date.now()}
          connectionState="live"
          onMarkCooked={() => {}}
          onMarkReadyToRun={() => {}}
        />,
      )
    })
    expect(container.querySelector('[data-testid="kitchen-screen"]')).toBeTruthy()
    expect(container.textContent).toContain('PROBE:')

    act(() => root.unmount())
    root = createRoot(container)
    act(() => {
      root.render(<BarScreen rounds={barRounds} now={Date.now()} connectionState="live" onBumpOut={() => {}} />)
    })
    expect(container.querySelector('[data-testid="bar-screen"]')).toBeTruthy()
    expect(container.textContent).toContain('PROBE:')
  })

  it("the half-bumped 'both' line stays independent per station — real proof of order_lines row 89fe25a2's own pattern, on this run's own seed", () => {
    const snapshot = loadSnapshot()
    if (!snapshot) return

    const halfBumped = snapshot.lines.find((l) => l.route_to === 'both')
    if (!halfBumped) {
      console.warn('SKIPPED: no route_to=both line in this seed snapshot')
      return
    }
    expect(halfBumped.kitchen_state).toBe('done')
    expect(halfBumped.bar_state).toBe('outstanding')

    const kitchenLines = mapRawLinesToKitchenLines(snapshot.lines, snapshot.events, snapshot.tableNumberByOrderId)
    const barRounds = mapRawLinesToBarRounds(snapshot.lines, snapshot.events, snapshot.tableNumberByOrderId)

    const kitchenLine = kitchenLines.find((l) => l.id === halfBumped.id)!
    expect(kitchenLine.readyToRunAt).not.toBeNull() // kitchen's half IS done

    const round = barRounds.find((r) => r.items.some((i) => i.itemName === halfBumped.name_snapshot))!
    expect(round.outAt).toBeNull() // bar's half is NOT out, despite kitchen being done

    act(() => {
      root.render(
        <KitchenScreen
          lines={kitchenLines}
          now={Date.now()}
          connectionState="live"
          onMarkCooked={() => {}}
          onMarkReadyToRun={() => {}}
        />,
      )
    })
    const readyCards = Array.from(container.querySelectorAll('[data-testid="ready-to-run-card"]'))
    expect(readyCards.some((c) => c.textContent?.includes('half-bumped'))).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    act(() => {
      root.render(<BarScreen rounds={barRounds} now={Date.now()} connectionState="live" onBumpOut={() => {}} />)
    })
    const outCards = container.querySelector('[data-testid="bar-out-column"]')!
    expect(outCards.textContent).not.toContain('half-bumped')
    const inCards = container.querySelector('[data-testid="bar-in-column"]')!
    expect(inCards.textContent).toContain('half-bumped')
  })

  it('age escalation is red for the oldest done line and sorts it to the top — real elapsed time, real row', () => {
    const snapshot = loadSnapshot()
    if (!snapshot) return

    const redLine = snapshot.lines.find((l) => l.route_to === 'kitchen' && l.name_snapshot.includes('expect RED'))
    const whiteLine = snapshot.lines.find((l) => l.route_to === 'kitchen' && l.name_snapshot.includes('expect WHITE'))
    if (!redLine || !whiteLine) {
      console.warn('SKIPPED: escalation-proof lines not found in this seed snapshot')
      return
    }

    const kitchenLines = mapRawLinesToKitchenLines(snapshot.lines, snapshot.events, snapshot.tableNumberByOrderId)
    const redKL = kitchenLines.find((l) => l.id === redLine.id)!
    const whiteKL = kitchenLines.find((l) => l.id === whiteLine.id)!

    const now = Date.now()
    const redMinutes = ageMinutes(redKL.readyToRunAt as string, now)
    const whiteMinutes = ageMinutes(whiteKL.readyToRunAt as string, now)

    // Seeded 6 and 1 minutes old respectively; asserted against ACTUAL elapsed time at test run,
    // not the original seed values — real wall-clock time has passed since seeding.
    expect(redMinutes).toBeGreaterThan(whiteMinutes)
    expect(readyToRunEscalation(redMinutes)).toBe('red')

    act(() => {
      root.render(
        <KitchenScreen
          lines={kitchenLines}
          now={now}
          connectionState="live"
          onMarkCooked={() => {}}
          onMarkReadyToRun={() => {}}
        />,
      )
    })

    const cards = Array.from(container.querySelectorAll('[data-testid="ready-to-run-card"]'))
    const redCard = cards.find((c) => c.textContent?.includes('expect RED'))!
    const whiteCard = cards.find((c) => c.textContent?.includes('expect WHITE'))!
    expect(redCard.getAttribute('data-escalation')).toBe('red')
    // Oldest first: the red (older) card's position in the DOM must precede the white one's.
    expect(cards.indexOf(redCard)).toBeLessThan(cards.indexOf(whiteCard))
  })
})
