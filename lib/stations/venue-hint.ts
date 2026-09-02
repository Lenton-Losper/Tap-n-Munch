/**
 * THE VENUE HINT — A CHECK, NEVER AN AUTHORITY.
 *
 * ============================================================================================
 * THE FAILURE THIS CLOSES
 * ============================================================================================
 *
 * Opening a station from a venue's dashboard did not fix the original bug, it only moved its
 * entrance. A browser holding an FNB ChowNow token, clicking Open on Riviera's page, lands on
 * ChowNow's board — correctly, by the token — and looks exactly like a quiet Riviera shift. That
 * is the same 45-minute misdiagnosis with a different door.
 *
 * ============================================================================================
 * WHY A HINT AND NOT A SCOPE
 * ============================================================================================
 *
 * The terminal JWT decides which restaurant a board shows, and it remains the ONLY thing that
 * does. A URL that could select a venue would be a second, weaker answer to a question the token
 * already answers, and it would hand a wrong-venue pairing a fresh way to happen.
 *
 * So the hint grants nothing. It is never read to fetch, filter, authorise or scope anything. Its
 * entire job is to be COMPARED against what the token resolved to, so a human can be told the two
 * disagree. Delete the parameter and the board behaves exactly as it did before — that property is
 * asserted in the tests, because it is the one that keeps this from becoming an authority by
 * accident.
 *
 * `name` is display-only and never compared. It exists so the warning can say "you opened this
 * from Riviera" rather than quoting a uuid at a chef. Anyone can put any name in a URL; the only
 * sentence it appears in already states the authoritative venue beside it, from the session.
 */
export const VENUE_HINT_ID_PARAM = 'from'
export const VENUE_HINT_NAME_PARAM = 'fromName'

export type VenueHint = {
  /** The restaurant the dashboard THOUGHT it was opening. Compared, never trusted. */
  id: string | null
  /** Display-only, for the warning sentence. Never compared, never used to fetch. */
  name: string | null
}

export function readVenueHint(search: string): VenueHint {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const id = (params.get(VENUE_HINT_ID_PARAM) ?? '').trim()
    const name = (params.get(VENUE_HINT_NAME_PARAM) ?? '').trim()
    return { id: id || null, name: name || null }
  } catch {
    // A malformed query string is not a reason to fail to open a kitchen board.
    return { id: null, name: null }
  }
}

/**
 * True only when the dashboard named a venue AND the token resolved to a different one.
 *
 * NO HINT MEANS NO OPINION. A wall screen launched from its own installed icon carries no
 * parameter and must reach exactly the board it reached yesterday.
 */
export function isVenueMismatch(hint: VenueHint, sessionRestaurantId: string | null | undefined): boolean {
  if (!hint.id) return false
  const actual = (sessionRestaurantId ?? '').trim()
  if (!actual) return false
  return hint.id !== actual
}

/** Build the dashboard's Open link. The only place a hint is ever produced. */
export function stationHrefWithVenueHint(
  startUrl: string,
  restaurantId: string,
  restaurantName: string | null,
): string {
  const params = new URLSearchParams({ [VENUE_HINT_ID_PARAM]: restaurantId })
  const name = (restaurantName ?? '').trim()
  if (name) params.set(VENUE_HINT_NAME_PARAM, name)
  return `${startUrl}?${params.toString()}`
}
