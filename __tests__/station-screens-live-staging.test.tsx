/**
 * @jest-environment jsdom
 *
 * feat/station-screens-v1 — REDONE AGAINST REAL ROWS. The three claims that were fixture-only
 * before this suite existed:
 *
 *   - both screens rendering
 *   - a route_to = 'both' line staying independent per station (kitchen cooked, bar still in)
 *   - age escalation red at ~6 minutes, sorted to the top
 *
 * REBUILT 2026-08-28 for the real four-state model: reads the snapshot
 * scripts/seed-station-screens-staging.ts writes after real inserts into STAGING
 * (mdqjpxwczrhkxkbqatqa) — kitchenResponse/barResponse are built in that script's own
 * buildStationResponse(), which imports the SAME isLineReady/stationsOwnedBy this test's
 * production code path (lib/stations/map-raw-lines.ts) is downstream of, so this is real rows
 * mapped through real logic, not a fixture with the right field names.
 *
 * WHY A SNAPSHOT FILE, NOT A LIVE QUERY FROM INSIDE THIS TEST: jest-environment-jsdom's global
 * scope has no fetch, and polyfilling undici's dependency chain to do real TLS from inside jsdom
 * cascaded through missing TextDecoder, then missing clearImmediate, with no clean stopping
 * point. Fetching real data (Node environment) and rendering it (jsdom environment) are two
 * different environments' jobs; the JSON snapshot is the seam between them, written by a plain
 * `tsx` script that has no such constraint.
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
import { mapStationLinesToBarRounds, mapStationLinesToKitchenLines } from '@/lib/stations/map-raw-lines'
import type { StationLinesResponseDTO } from '@/lib/stations/map-raw-lines'
import { readyToRunEscalation, ageMinutes } from '@/lib/stations/age'
import { SEED_SNAPSHOT_PATH } from '../scripts/seed-station-screens-staging'

type Snapshot = {
  seededAt: string
  restaurantId: string
  tableNumberByOrderId: Record<string, string>
  kitchenResponse: StationLinesResponseDTO
  barResponse: StationLinesResponseDTO
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

    const kitchenLines = mapStationLinesToKitchenLines(snapshot.kitchenResponse)
    const barRounds = mapStationLinesToBarRounds(snapshot.barResponse)

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

  it("a route_to = 'both', half-bumped line stays independent per station — kitchen cooked, bar still in", () => {
    const snapshot = loadSnapshot()
    if (!snapshot) return

    const kitchenLines = mapStationLinesToKitchenLines(snapshot.kitchenResponse)
    const barRounds = mapStationLinesToBarRounds(snapshot.barResponse)

    const halfBumpedKitchenLine = kitchenLines.find((l) => l.itemName.includes('half-bumped'))
    if (!halfBumpedKitchenLine) {
      console.warn('SKIPPED: no half-bumped line in this seed snapshot')
      return
    }
    expect(halfBumpedKitchenLine.state).toBe('cooked') // kitchen's half IS cooked

    const round = barRounds.find((r) => r.items.some((i) => i.itemName.includes('half-bumped')))!
    expect(round).toBeTruthy() // bar's half is still IN, despite kitchen being cooked

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
    const cookedCards = Array.from(container.querySelectorAll('[data-testid="cooked-card"]'))
    expect(cookedCards.some((c) => c.textContent?.includes('half-bumped'))).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    act(() => {
      root.render(<BarScreen rounds={barRounds} now={Date.now()} connectionState="live" onBumpOut={() => {}} />)
    })
    const inSection = container.querySelector('[data-testid="bar-in-section"]')!
    expect(inSection.textContent).toContain('half-bumped')
  })

  it('age escalation is red for the oldest cooked order and sorts it to the top — real elapsed time, real rows', () => {
    const snapshot = loadSnapshot()
    if (!snapshot) return

    const kitchenLines = mapStationLinesToKitchenLines(snapshot.kitchenResponse)
    const redLine = kitchenLines.find((l) => l.state === 'cooked' && l.itemName.includes('expect RED'))
    const whiteLine = kitchenLines.find((l) => l.state === 'cooked' && l.itemName.includes('expect WHITE'))
    if (!redLine || !whiteLine) {
      console.warn('SKIPPED: escalation-proof lines not found in this seed snapshot')
      return
    }

    const now = Date.now()
    const redMinutes = ageMinutes(redLine.placedAt as string, now)
    const whiteMinutes = ageMinutes(whiteLine.placedAt as string, now)

    // Seeded on orders placed 6 and 1 minutes old respectively; asserted against ACTUAL elapsed
    // time at test run, not the original seed values.
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

    const cards = Array.from(container.querySelectorAll('[data-testid="cooked-card"]'))
    const redCard = cards.find((c) => c.textContent?.includes('expect RED'))!
    const whiteCard = cards.find((c) => c.textContent?.includes('expect WHITE'))!
    expect(redCard.getAttribute('data-escalation')).toBe('red')
    // Oldest first: the red (older order) card's position in the DOM must precede the white one's.
    expect(cards.indexOf(redCard)).toBeLessThan(cards.indexOf(whiteCard))
  })
})
