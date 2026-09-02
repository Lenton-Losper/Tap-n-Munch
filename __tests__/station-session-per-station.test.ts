/**
 * @jest-environment jsdom
 *
 * A KITCHEN BOARD AND A BAR BOARD MUST BOTH BE PAIRED IN ONE BROWSER PROFILE.
 *
 * The session was persisted under a single origin-wide localStorage key. /kitchen and /bar read
 * and wrote the same entry, so pairing the bar overwrote the kitchen's token and both boards then
 * used whichever was paired last.
 *
 * Two things followed, both seen on 2026-09-02: two boards could not be paired in one profile at
 * all (hence an operator resorting to incognito), and a tab sitting at /kitchen could be holding a
 * token paired elsewhere entirely — which the board would render perfectly correctly.
 *
 * The server was never at fault. restaurant_terminals rows are per terminal with their own
 * station_kind, and activation only ever updates the row whose code was redeemed. This is purely
 * about where the token is kept.
 */
import {
  readStoredSession,
  writeStoredSession,
  type TerminalSession,
} from '@/lib/stations/use-terminal-session'

const LEGACY_KEY = 'flashtap.station.terminal-session.v1'

const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  accessToken: 'access-k',
  refreshToken: 'refresh-k',
  restaurantId: 'riviera-id',
  terminalId: 'terminal-kitchen',
  restaurantName: 'Riviera',
  ...over,
})

beforeEach(() => window.localStorage.clear())

describe('two stations, one browser profile', () => {
  it('keeps a kitchen and a bar session side by side', () => {
    const kitchen = session({ terminalId: 'terminal-kitchen' })
    const bar = session({ terminalId: 'terminal-bar', accessToken: 'access-b' })

    writeStoredSession('kitchen', kitchen)
    writeStoredSession('bar', bar)

    expect(readStoredSession('kitchen')?.terminalId).toBe('terminal-kitchen')
    expect(readStoredSession('bar')?.terminalId).toBe('terminal-bar')
  })

  it('pairing the second station does NOT displace the first', () => {
    // The exact reported failure.
    writeStoredSession('kitchen', session({ terminalId: 'terminal-kitchen' }))
    const before = readStoredSession('kitchen')

    writeStoredSession('bar', session({ terminalId: 'terminal-bar' }))

    expect(readStoredSession('kitchen')).toEqual(before)
    expect(readStoredSession('kitchen')?.terminalId).toBe('terminal-kitchen')
  })

  it('lets the two stations belong to different venues without interfering', () => {
    // A screen paired to the wrong venue must stay confined to its own station's slot rather than
    // leaking into the other board, which is how a "kitchen" tab ended up on another venue.
    writeStoredSession('kitchen', session({ restaurantId: 'chownow-id', restaurantName: 'FNB ChowNow' }))
    writeStoredSession('bar', session({ restaurantId: 'riviera-id', restaurantName: 'Riviera' }))

    expect(readStoredSession('kitchen')?.restaurantName).toBe('FNB ChowNow')
    expect(readStoredSession('bar')?.restaurantName).toBe('Riviera')
  })

  it('survives a reload — the sessions are read back from storage, not from memory', () => {
    writeStoredSession('kitchen', session({ terminalId: 'terminal-kitchen' }))
    writeStoredSession('bar', session({ terminalId: 'terminal-bar' }))

    // Nothing in-memory carries over a reload; localStorage is the only thing that does.
    expect(readStoredSession('kitchen')?.terminalId).toBe('terminal-kitchen')
    expect(readStoredSession('bar')?.terminalId).toBe('terminal-bar')
    expect(window.localStorage.getItem(`${LEGACY_KEY}:kitchen`)).toBeTruthy()
    expect(window.localStorage.getItem(`${LEGACY_KEY}:bar`)).toBeTruthy()
  })

  it('clearing one station leaves the other paired', () => {
    writeStoredSession('kitchen', session())
    writeStoredSession('bar', session({ terminalId: 'terminal-bar' }))

    writeStoredSession('kitchen', null)

    expect(readStoredSession('kitchen')).toBeNull()
    expect(readStoredSession('bar')?.terminalId).toBe('terminal-bar')
  })
})

describe('adopting a session paired before this fix', () => {
  it('a screen already paired keeps working instead of silently needing re-activation', () => {
    // Every screen in the field has a session under the old key. Losing them on deploy would mean
    // re-pairing wall screens during service.
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(session({ terminalId: 'legacy-terminal' })))

    expect(readStoredSession('kitchen')?.terminalId).toBe('legacy-terminal')
  })

  it('moves it into that station and removes the shared key, so it is adopted once', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(session({ terminalId: 'legacy-terminal' })))

    readStoredSession('kitchen')

    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(readStoredSession('kitchen')?.terminalId).toBe('legacy-terminal')
    // …and the other station does NOT also inherit it, which would rebuild the original bug.
    expect(readStoredSession('bar')).toBeNull()
  })

  it('never lets the legacy key override a station that is already paired', () => {
    writeStoredSession('kitchen', session({ terminalId: 'current-terminal' }))
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(session({ terminalId: 'stale-terminal' })))

    expect(readStoredSession('kitchen')?.terminalId).toBe('current-terminal')
  })
})

describe('storage that refuses to cooperate', () => {
  it('reads a corrupt entry as unpaired rather than throwing on a wall screen', () => {
    window.localStorage.setItem(`${LEGACY_KEY}:kitchen`, '{not json')
    expect(readStoredSession('kitchen')).toBeNull()
  })

  it('rejects a session missing any field the API calls depend on', () => {
    window.localStorage.setItem(`${LEGACY_KEY}:bar`, JSON.stringify({ accessToken: 'a' }))
    expect(readStoredSession('bar')).toBeNull()
  })
})
