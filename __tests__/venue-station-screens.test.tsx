/**
 * @jest-environment jsdom
 *
 * A WRONG PAIRING MUST BE VISIBLE FROM THE DASHBOARD.
 *
 * On 2026-09-02 a kitchen screen standing in Riviera was paired to FNB ChowNow. The only place
 * that fact existed was the screen's own token, and the screen was showing an empty board — which
 * looks exactly like a quiet shift. It took 45 minutes and a production query to find.
 *
 * This panel puts the same fact on the venue's page. The assertions that carry the weight are the
 * ones about ABSENCE and DUPLICATION: a station with no screen, and a station with two, are both
 * things an owner needs to see without being told to look.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VenueStationScreens, type VenueStationScreen } from '@/components/admin/venue-station-screens'
import { VENUE_LAUNCHER_COPY as COPY } from '@/lib/stations/venue-launcher-copy'

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)

const screen = (over: Partial<VenueStationScreen>): VenueStationScreen => ({
  id: 'id-1',
  stationKind: 'kitchen',
  name: 'Kitchen Screen',
  status: 'active',
  active: true,
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  activatedAt: new Date(NOW - 3_600_000).toISOString(),
  ...over,
})

describe('VenueStationScreens', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (screens: VenueStationScreen[]) => {
    act(() => root.render(<VenueStationScreens screens={screens} now={NOW} />))
    return container
  }

  it('shows both stations even when the venue has neither', () => {
    const el = render([])
    expect(el.querySelector('[data-testid="venue-station-kitchen"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="venue-station-bar"]')).toBeTruthy()
  })

  it('says plainly when a station has no screen, and how to fix it', () => {
    const el = render([])
    const kitchen = el.querySelector('[data-testid="venue-station-kitchen"]')!
    expect(kitchen.getAttribute('data-paired-count')).toBe('0')
    expect(kitchen.textContent).toContain(COPY.nonePaired)
    expect(kitchen.textContent).toContain(COPY.nonePairedHint)
  })

  it('lists a paired screen with when it was last seen', () => {
    const el = render([screen({})])
    const kitchen = el.querySelector('[data-testid="venue-station-kitchen"]')!
    expect(kitchen.getAttribute('data-paired-count')).toBe('1')
    expect(kitchen.textContent).toContain('Kitchen Screen')
    expect(kitchen.textContent).toContain(COPY.seenRecently)
  })

  it('flags a station that has more than one screen', () => {
    // Legitimate, but worth saying: two screens both showing the same orders surprises people.
    const el = render([screen({ id: 'a' }), screen({ id: 'b', name: 'Second kitchen screen' })])
    const kitchen = el.querySelector('[data-testid="venue-station-kitchen"]')!
    expect(kitchen.getAttribute('data-paired-count')).toBe('2')
    expect(el.querySelector('[data-testid="venue-station-kitchen-multiple"]')).toBeTruthy()
  })

  it('does not count a revoked or inactive screen as paired', () => {
    // The row stays in the terminals table for its history; it must not read as a working screen.
    const el = render([
      screen({ id: 'r', status: 'revoked', active: false }),
      screen({ id: 'i', active: false }),
    ])
    const kitchen = el.querySelector('[data-testid="venue-station-kitchen"]')!
    expect(kitchen.getAttribute('data-paired-count')).toBe('0')
    expect(kitchen.textContent).toContain(COPY.nonePaired)
  })

  it('separates the two stations — a bar screen never counts as a kitchen one', () => {
    const el = render([screen({ id: 'b1', stationKind: 'bar', name: 'Bar Screen' })])
    expect(el.querySelector('[data-testid="venue-station-kitchen"]')!.getAttribute('data-paired-count')).toBe('0')
    expect(el.querySelector('[data-testid="venue-station-bar"]')!.getAttribute('data-paired-count')).toBe('1')
  })

  it('says a screen paired but never activated is still waiting', () => {
    const el = render([screen({ activatedAt: null, lastSeenAt: null })])
    expect(el.textContent).toContain(COPY.awaitingActivation)
  })

  it('opens each station on its own path', () => {
    const el = render([])
    expect(el.querySelector<HTMLAnchorElement>('[data-testid="venue-open-kitchen"]')!.getAttribute('href')).toBe('/kitchen')
    expect(el.querySelector<HTMLAnchorElement>('[data-testid="venue-open-bar"]')!.getAttribute('href')).toBe('/bar')
  })

  it('does not claim the link scopes the board to this venue', () => {
    /**
     * THE MISREADING THIS PANEL MUST NOT CAUSE. Which venue a board shows is decided by the
     * terminal JWT the DEVICE holds — a URL that could select a venue would be a second, weaker
     * answer to a question the token already answers. So the copy says where it actually opens.
     */
    const el = render([])
    expect(el.textContent).toContain(COPY.openNote)
    expect(el.textContent).toMatch(/not necessarily this venue/i)
  })

  it('uses no developer vocabulary an owner would have to decode', () => {
    const el = render([screen({})])
    expect(el.textContent ?? '').not.toMatch(/JWT|token|station_kind|terminal_id|restaurant_id|payload|PWA|manifest/i)
  })
})
