/**
 * lib/stations/station-pairing.ts — the check that makes "pair a screen" mean something. Without
 * it, any activation code works against both /kitchen and /bar interchangeably (both routes take
 * the same fixed-permission JWT, lib/terminals/terminal-jwt.ts).
 */
import {
  assertTerminalPairedToStation,
  isStationKind,
  StationPairingMismatchError,
} from '@/lib/stations/station-pairing'

function stubReturning(station_kind: string | null) {
  return {
    from(table: string) {
      if (table !== 'restaurant_terminals') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { station_kind }, error: null }),
            }),
          }),
        }),
      }
    },
  }
}

describe('isStationKind', () => {
  it.each(['kitchen', 'bar'])('accepts %s', (v) => {
    expect(isStationKind(v)).toBe(true)
  })

  it.each([null, undefined, '', 'grill', 'KITCHEN', 42])('rejects %p', (v) => {
    expect(isStationKind(v)).toBe(false)
  })
})

describe('assertTerminalPairedToStation', () => {
  const terminal = { terminalId: 'term-1', restaurantId: 'rest-1' }

  it('resolves silently when the terminal is paired to the expected station', async () => {
    await expect(
      assertTerminalPairedToStation(stubReturning('kitchen'), terminal, 'kitchen'),
    ).resolves.toBeUndefined()
  })

  it('throws when the terminal is paired to the OTHER station', async () => {
    const err = await assertTerminalPairedToStation(stubReturning('bar'), terminal, 'kitchen').catch((e) => e)
    expect(err).toBeInstanceOf(StationPairingMismatchError)
    expect((err as StationPairingMismatchError).pairedTo).toBe('bar')
    expect((err as StationPairingMismatchError).code).toBe('STATION_NOT_PAIRED')
  })

  it('throws when the terminal is not paired to any station (station_kind is null)', async () => {
    const err = await assertTerminalPairedToStation(stubReturning(null), terminal, 'bar').catch((e) => e)
    expect(err).toBeInstanceOf(StationPairingMismatchError)
    expect((err as StationPairingMismatchError).pairedTo).toBeNull()
  })

  it('treats an unrecognised stored value the same as unpaired, never as a match', async () => {
    // Defense in depth: if the CHECK constraint is ever loosened, a garbage value must still
    // refuse rather than accidentally satisfying `pairedTo === expected` by coincidence.
    const err = await assertTerminalPairedToStation(stubReturning('griddle'), terminal, 'kitchen').catch((e) => e)
    expect(err).toBeInstanceOf(StationPairingMismatchError)
    expect((err as StationPairingMismatchError).pairedTo).toBeNull()
  })

  it('propagates a real database error rather than swallowing it into a mismatch', async () => {
    const throwing = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }),
            }),
          }),
        }),
      }),
    }
    await expect(assertTerminalPairedToStation(throwing, terminal, 'kitchen')).rejects.toMatchObject({
      message: 'connection reset',
    })
  })
})
