/**
 * @jest-environment jsdom
 *
 * #373 — EVERY SCREEN MUST SAY WHAT IT IS RUNNING.
 *
 * `restaurant_terminals.app_version` was null for every web station screen, permanently: the board
 * beat with no body at all, and the heartbeat route only records a version when one is sent.
 *
 * That cost a long investigation on 2026-09-02. A waiter reported that marking a line collected
 * "reverted" it; the database was correct throughout; the cause was a till on a build older than
 * the commit that taught the terminal the word `collected`. The one field that answers "what is
 * this device running?" answered nothing.
 *
 * It is also a blocker for the private-channel migration: without it we cannot prove no old client
 * is still listening on the public channel before retiring it.
 *
 * The load-bearing assertion is that the version is the bundle THIS PAGE loaded — captured once,
 * never refreshed. A server-stamped value would report today's deploy for a screen that has been
 * up since Tuesday, hiding the exact staleness anyone is looking for.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getClientVersion, resetClientVersionForTest } from '@/lib/stations/client-version'
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

describe('getClientVersion', () => {
  beforeEach(() => {
    resetClientVersionForTest()
    jest.restoreAllMocks()
  })

  it('reports the deployment that served this page, shortened', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commit: '6683572653cbeabb534c47bbe11f5dec1aff86c6' }),
    }) as unknown as typeof fetch

    expect(await getClientVersion()).toBe('66835726')
  })

  it('asks ONCE and caches — the value must not drift while the page is open', async () => {
    // A screen up since Tuesday is running Tuesday's bundle. Re-reading would report today's
    // deploy and hide precisely the staleness this field exists to expose.
    const f = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ commit: 'abcdef1234567890' }) })
    global.fetch = f as unknown as typeof fetch

    await getClientVersion()
    await getClientVersion()
    await getClientVersion()

    expect(f).toHaveBeenCalledTimes(1)
  })

  it('degrades to null rather than throwing — a board must still show the pass', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    expect(await getClientVersion()).toBeNull()
  })

  it('degrades to null on a non-ok response, and on a malformed body', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch
    expect(await getClientVersion()).toBeNull()

    resetClientVersionForTest()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch
    expect(await getClientVersion()).toBeNull()
  })
})

describe('the venue panel shows what each screen runs', () => {
  let container: HTMLDivElement
  let root: Root

  const screen = (over: Partial<VenueStationScreen>): VenueStationScreen => ({
    id: 'a',
    stationKind: 'kitchen',
    name: 'Kitchen Screen',
    status: 'active',
    active: true,
    lastSeenAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    ...over,
  })

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
    act(() => root.render(<VenueStationScreens screens={screens} now={Date.now()} />))
    return container
  }

  it('shows the version a screen reported', () => {
    const el = render([screen({ appVersion: '66835726' })])
    expect(el.querySelector('[data-testid="screen-version"]')?.textContent).toBe('66835726')
  })

  it('says so when a screen has never reported one', () => {
    // Distinct from "running an old build" — this one has never told us, which is its own fact.
    const el = render([screen({ appVersion: null })])
    expect(el.querySelector('[data-testid="screen-version"]')?.textContent).toBe(COPY.versionUnknown)
  })

  it('treats a blank version as not reported rather than rendering an empty gap', () => {
    const el = render([screen({ appVersion: '   ' })])
    expect(el.querySelector('[data-testid="screen-version"]')?.textContent).toBe(COPY.versionUnknown)
  })
})
