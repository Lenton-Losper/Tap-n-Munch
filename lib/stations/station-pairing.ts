/**
 * Which screen a terminal is paired to (restaurant_terminals.station_kind,
 * 20260828230000_terminal_station_pairing.sql). A P5 / waiter terminal has station_kind = NULL
 * and this module has nothing to say about it.
 */
export const STATION_KINDS = ['kitchen', 'bar'] as const
export type StationKind = (typeof STATION_KINDS)[number]

export function isStationKind(value: unknown): value is StationKind {
  return typeof value === 'string' && (STATION_KINDS as readonly string[]).includes(value)
}

export class StationPairingMismatchError extends Error {
  readonly code = 'STATION_NOT_PAIRED'
  readonly pairedTo: StationKind | null
  readonly expected: StationKind

  constructor(pairedTo: StationKind | null, expected: StationKind) {
    super(
      pairedTo
        ? `This screen is paired to '${pairedTo}', not '${expected}'.`
        : `This terminal is not paired to a station screen.`,
    )
    this.name = 'StationPairingMismatchError'
    this.pairedTo = pairedTo
    this.expected = expected
  }
}

/**
 * Refuse a request unless the terminal is paired to `expected`. Throws
 * StationPairingMismatchError rather than returning a boolean so a caller cannot forget to check
 * the result -- the same shape requireTerminalAuth already uses (throw a Response-shaped error,
 * let the route's catch block answer it).
 *
 * Read fresh from the DB rather than trusting the JWT: the JWT's permission set is fixed and
 * carries no station_kind at all (lib/terminals/terminal-jwt.ts), and even if it did, a pairing
 * revoked mid-token-lifetime must take effect before the hour is up, not after.
 */
export async function assertTerminalPairedToStation(
  supabase: { from: (table: string) => any },
  terminal: { terminalId: string; restaurantId: string },
  expected: StationKind,
): Promise<void> {
  const { data, error } = await supabase
    .from('restaurant_terminals')
    .select('station_kind')
    .eq('id', terminal.terminalId)
    .eq('restaurant_id', terminal.restaurantId)
    .maybeSingle()

  if (error) throw error

  const pairedTo = isStationKind(data?.station_kind) ? data.station_kind : null
  if (pairedTo !== expected) {
    throw new StationPairingMismatchError(pairedTo, expected)
  }
}
