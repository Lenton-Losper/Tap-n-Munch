/**
 * @jest-environment jsdom
 *
 * ONE-CLICK PAIRING — AND THE THINGS THAT MAKE IT SAFE TO HAVE.
 *
 * The link carries the EXISTING activation code rather than a second kind of secret. That code is
 * already server-issued from a CSPRNG, bound to a restaurant_terminals row (and so to a venue and
 * a station), single-use, one-hour, and redeemed through a rate-limited route. Minting a parallel
 * credential would mean a second expiry, a second revocation path and a second thing to audit, to
 * obtain properties the first one already has.
 *
 * What this file pins is the delivery, and the two properties that keep a code in a URL acceptable:
 *
 *   1. it is STRIPPED from the address bar before it is even submitted, so a failure cannot leave
 *      a spent or invalid code to be reloaded, bookmarked or photographed;
 *   2. it is attempted EXACTLY ONCE, so a re-run of the effect cannot report "invalid or expired"
 *      over a pairing that already succeeded.
 *
 * And that the typed fallback is untouched.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  stationActivationLink,
  readActivationCode,
  stripActivationParam,
  ACTIVATION_LINK_PARAM,
} from '@/lib/stations/activation-link'
import { TerminalActivationGate } from '@/components/stations/terminal-activation-gate'
import { STATION_COPY } from '@/lib/stations/copy'

const activate = jest.fn()
let fakeSession: { restaurantId: string; restaurantName: string } | null = null

jest.mock('@/lib/stations/use-terminal-session', () => ({
  useTerminalSession: () => ({ session: fakeSession, loaded: true, activate, authFetch: jest.fn() }),
}))

describe('building the link', () => {
  it('points at the station and carries the code', () => {
    const href = stationActivationLink('kitchen', 'FT-AB12-CD34')
    expect(href).toBe(`/kitchen?${ACTIVATION_LINK_PARAM}=FT-AB12-CD34`)
    expect(stationActivationLink('bar', 'FT-AB12-CD34')).toContain('/bar?')
  })

  it('can be made absolute so it survives being sent to another machine', () => {
    expect(stationActivationLink('kitchen', 'FT-AB12-CD34', 'https://flashtap.app')).toBe(
      `https://flashtap.app/kitchen?${ACTIVATION_LINK_PARAM}=FT-AB12-CD34`,
    )
  })
})

describe('reading and stripping', () => {
  it('reads the code when present, and nothing when not', () => {
    expect(readActivationCode('?activate=FT-AB12-CD34')).toBe('FT-AB12-CD34')
    expect(readActivationCode('')).toBeNull()
    expect(readActivationCode('?from=abc')).toBeNull()
    expect(readActivationCode('?activate=')).toBeNull()
  })

  it('removes ONLY the code, keeping the venue hint intact', () => {
    // The two parameters do different jobs; stripping one must not silently disable the other.
    expect(stripActivationParam('?activate=FT-AB12-CD34&from=riviera-id')).toBe('?from=riviera-id')
    expect(stripActivationParam('?activate=FT-AB12-CD34')).toBe('')
    expect(stripActivationParam('?from=riviera-id')).toBe('?from=riviera-id')
  })
})

describe('the gate pairs itself from a link', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fakeSession = null
    activate.mockReset()
    window.history.replaceState(null, '', '/kitchen')
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const mount = async () => {
    await act(async () => {
      root.render(<TerminalActivationGate station="kitchen">{() => <div>BOARD</div>}</TerminalActivationGate>)
    })
  }

  it('redeems the code without anyone typing it', async () => {
    window.history.replaceState(null, '', '/kitchen?activate=FT-AB12-CD34')
    activate.mockImplementation(async () => {
      fakeSession = { restaurantId: 'riviera-id', restaurantName: 'Riviera' }
      return { error: null }
    })

    await mount()

    expect(activate).toHaveBeenCalledWith('FT-AB12-CD34')
    // and lands on the pairing confirmation, which names the venue it actually got
    expect(container.querySelector('[data-testid="terminal-paired-confirmation"]')).toBeTruthy()
    expect(container.textContent).toContain('Riviera')
  })

  it('strips the code from the address bar, keeping the venue hint', async () => {
    window.history.replaceState(null, '', '/kitchen?activate=FT-AB12-CD34&from=riviera-id')
    activate.mockResolvedValue({ error: null })

    await mount()

    expect(window.location.search).not.toContain('FT-AB12-CD34')
    expect(window.location.search).toContain('from=riviera-id')
  })

  it('strips it even when the code is refused, so a dead code cannot be reloaded', async () => {
    window.history.replaceState(null, '', '/kitchen?activate=FT-DEAD-BEEF')
    activate.mockResolvedValue({ error: STATION_COPY.activation.invalidCode })

    await mount()

    expect(window.location.search).toBe('')
    expect(container.textContent).toContain(STATION_COPY.activation.invalidCode)
    // the typed form is still there to fall back on
    expect(container.querySelector('[data-testid="terminal-activation-gate"]')).toBeTruthy()
  })

  it('attempts the code exactly once', async () => {
    window.history.replaceState(null, '', '/kitchen?activate=FT-AB12-CD34')
    activate.mockResolvedValue({ error: null })

    await mount()
    // a re-render must not resubmit: the code is spent, and a second try would report
    // "invalid or expired" over a pairing that worked.
    await act(async () => {
      root.render(<TerminalActivationGate station="kitchen">{() => <div>BOARD</div>}</TerminalActivationGate>)
    })

    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when there is no code — the normal launch', async () => {
    await mount()
    expect(activate).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="terminal-activation-gate"]')).toBeTruthy()
  })

  it('does not re-pair a screen that already has a session', async () => {
    fakeSession = { restaurantId: 'riviera-id', restaurantName: 'Riviera' }
    window.history.replaceState(null, '', '/kitchen?activate=FT-AB12-CD34')

    await mount()

    expect(activate).not.toHaveBeenCalled()
    expect(container.textContent).toContain('BOARD')
  })
})
