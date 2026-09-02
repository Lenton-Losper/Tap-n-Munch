/**
 * @jest-environment jsdom
 *
 * #371 — A SCREEN MUST SAY WHOSE ORDERS IT IS SHOWING.
 *
 * On 2026-09-02 a kitchen screen standing in Riviera was paired, with a code generated from
 * another venue's settings page, to FNB ChowNow. Nothing on the screen said so. "Paired to the
 * wrong venue" and "nothing to do right now" both rendered as "Nothing waiting", so the board
 * looked merely quiet for 45 minutes.
 *
 * The assertions that matter:
 *   - the venue is on the board AND on the empty state (the empty state is when it is asked);
 *   - a missing venue name renders as a visible fact, never as blank space;
 *   - pairing confirms the venue while somebody is still standing there;
 *   - a screen that merely RELOADS does not stop on that confirmation — a wall screen rebooting
 *     at 6am must come back to the board by itself.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StationVenueHeader } from '@/components/stations/station-venue-header'
import { StationFaultNotice } from '@/components/stations/station-fault-notice'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { STATION_COPY } from '@/lib/stations/copy'

const activate = jest.fn()
let fakeSession: { restaurantName: string } | null = null

jest.mock('@/lib/stations/use-terminal-session', () => ({
  useTerminalSession: () => ({
    session: fakeSession,
    loaded: true,
    activate,
    authFetch: jest.fn(),
  }),
}))

describe('#371 the venue is on the screen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fakeSession = null
    activate.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (node: React.ReactNode) => {
    act(() => root.render(node))
    return container
  }

  it('names the station and the venue together on the board header', () => {
    const el = render(<StationVenueHeader station="kitchen" venueName="Riviera" />)
    const header = el.querySelector('[data-testid="station-venue-header"]') as HTMLElement
    expect(header.textContent).toContain('Kitchen')
    expect(header.textContent).toContain('Riviera')
    expect(header.getAttribute('data-venue')).toBe('Riviera')
  })

  it('says so when the venue is unknown, instead of rendering nothing', () => {
    for (const missing of [null, '', '   ']) {
      const el = render(<StationVenueHeader station="bar" venueName={missing} />)
      const header = el.querySelector('[data-testid="station-venue-header"]') as HTMLElement
      expect(header.textContent).toContain(STATION_COPY.venue.unknownName)
      expect(header.getAttribute('data-venue')).toBe('unknown')
    }
  })

  it('puts the venue on the EMPTY state too — the moment it is actually asked', () => {
    const el = render(<StationFaultNotice fault="screens_disabled" station="kitchen" venueName="Riviera" />)
    expect(el.querySelector('[data-testid="station-venue-header"]')?.textContent).toContain('Riviera')
    // and still says what is wrong
    expect(el.textContent).toContain(STATION_COPY.faults.screensDisabled.heading)
  })

  it('offers a way out when the empty state does not know its venue either', () => {
    const el = render(<StationFaultNotice fault="screens_disabled" station="kitchen" venueName={null} />)
    expect(el.textContent).toContain(STATION_COPY.venue.unknownHelp)
  })

  it('confirms the venue at the moment of pairing, before the board', async () => {
    activate.mockImplementation(async () => {
      fakeSession = { restaurantName: 'FNB ChowNow' }
      return { error: null }
    })

    const el = render(
      <TerminalActivationGate station="kitchen">{() => <div>BOARD</div>}</TerminalActivationGate>,
    )

    const input = el.querySelector('input') as HTMLInputElement
    const form = el.querySelector('form') as HTMLFormElement
    act(() => {
      input.value = 'CODE123'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    const confirmation = el.querySelector('[data-testid="terminal-paired-confirmation"]') as HTMLElement
    expect(confirmation).toBeTruthy()
    // The whole point: the venue that the CODE belonged to, named out loud.
    expect(confirmation.textContent).toContain('FNB ChowNow')
    expect(confirmation.getAttribute('data-venue')).toBe('FNB ChowNow')
    expect(confirmation.textContent).toContain(STATION_COPY.activation.pairedWrongVenueHint)
    // and the board is not showing yet
    expect(el.textContent).not.toContain('BOARD')
  })

  it('does NOT stop on the confirmation when a paired screen simply reloads', () => {
    // A wall screen rebooting overnight has nobody standing at it to press a button.
    fakeSession = { restaurantName: 'Riviera' }
    const el = render(
      <TerminalActivationGate station="bar">{() => <div>BOARD</div>}</TerminalActivationGate>,
    )
    expect(el.textContent).toContain('BOARD')
    expect(el.querySelector('[data-testid="terminal-paired-confirmation"]')).toBeNull()
  })
})
