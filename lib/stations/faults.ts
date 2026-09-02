/**
 * ONE VOCABULARY FOR "THE BOARD CANNOT LOAD", SHARED BY THE SERVER AND THE SCREEN (#370).
 *
 * ============================================================================================
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 * ============================================================================================
 *
 * The screen used to decide what to render like this:
 *
 *     const notPaired = body.code === 'STATION_NOT_PAIRED'
 *     return { notEnabled: !notPaired, ... }
 *
 * `notEnabled` was therefore not a reading of any flag. It was "a 403 arrived and it was not the
 * pairing one" -- so every other refusal, including ones that have nothing to do with the venue's
 * settings, rendered "Station screens are not turned on yet. Ask whoever manages this venue to
 * enable kitchen and bar screens for it."
 *
 * On 2026-09-02 a kitchen screen at Riviera showed exactly that for ~45 minutes while Riviera's
 * `station_screens_enabled` was `true` the entire time. The screen was paired to a different
 * venue whose flag was false. The operator kept checking Riviera's setting, which looked correct,
 * because it was correct. The message named a real setting and the wrong venue's copy of it.
 *
 * ============================================================================================
 * THE RULE
 * ============================================================================================
 *
 * An UNRECOGNISED failure must never resolve to a specific diagnosis. `stationFaultFromCode`
 * returns 'unknown' for an absent code, an unrecognised code, and any non-403 failure -- and
 * 'unknown' renders "something went wrong", not "your manager forgot to switch this on". Guessing
 * a cause from the absence of evidence is the entire bug; a screen that admits it does not know
 * sends nobody anywhere.
 *
 * The server already distinguished these on the wire. The client was throwing it away.
 */
import type { FeatureDenialReason } from '@/lib/features/get-restaurant-features'

/** The wire values. `STATION_SCREENS_DISABLED` and `STATION_NOT_PAIRED` predate #370 and keep
 *  their exact spelling -- they are already deployed and already asserted against. */
export const STATION_FAULT_CODES = {
  SCREENS_DISABLED: 'STATION_SCREENS_DISABLED',
  SCREENS_NOT_CONFIGURED: 'STATION_SCREENS_NOT_CONFIGURED',
  SCREENS_UNAVAILABLE: 'STATION_SCREENS_UNAVAILABLE',
  NOT_PAIRED: 'STATION_NOT_PAIRED',
  MISSING_PERMISSION: 'STATION_MISSING_PERMISSION',
} as const

/** What the screen renders. One per distinct fault, plus the honest fallback. */
export type StationFault =
  /** The venue's row exists and station_screens_enabled is false. A manager switches it on. */
  | 'screens_disabled'
  /** No restaurant_features row at all. Nothing to switch on; it has to be set up first. */
  | 'screens_not_configured'
  /** The settings read itself failed. Not a setting, not the operator, nothing to go and change. */
  | 'screens_unavailable'
  /** Authenticated, but this terminal is not paired to THIS screen. */
  | 'not_paired'
  /** Paired, but the token carries no orders:read scope. Re-pairing is the fix, not a venue flag. */
  | 'missing_permission'
  /** Anything we do not recognise. Deliberately terminal: never guess a cause from silence. */
  | 'unknown'

/**
 * Map a feature denial to its wire code. Kept beside the fault vocabulary rather than inside the
 * feature module so `lib/features` does not have to know that station screens exist.
 */
export function featureDenialCode(reason: FeatureDenialReason | undefined): string {
  if (reason === 'not_configured') return STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED
  if (reason === 'unreadable') return STATION_FAULT_CODES.SCREENS_UNAVAILABLE
  return STATION_FAULT_CODES.SCREENS_DISABLED
}

/**
 * The 403 body for a feature denial. Returns a plain object rather than a NextResponse so this
 * module stays importable from client code -- `data-port.ts` needs the codes on the other side.
 */
export function featureDenialBody(reason: FeatureDenialReason | undefined): {
  error: string
  code: string
} {
  const code = featureDenialCode(reason)
  if (code === STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED) {
    return { error: 'Station screens have not been set up for this restaurant', code }
  }
  if (code === STATION_FAULT_CODES.SCREENS_UNAVAILABLE) {
    return { error: 'Could not read this restaurant feature settings', code }
  }
  return { error: 'Station screens are not enabled for this restaurant', code }
}

/**
 * TOTAL, and the fallback is 'unknown' rather than any specific fault. See the file docblock:
 * resolving an unrecognised code to a diagnosis is the defect, not a convenience.
 */
export function stationFaultFromCode(code: string | null | undefined): StationFault {
  switch (code) {
    case STATION_FAULT_CODES.SCREENS_DISABLED:
      return 'screens_disabled'
    case STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED:
      return 'screens_not_configured'
    case STATION_FAULT_CODES.SCREENS_UNAVAILABLE:
      return 'screens_unavailable'
    case STATION_FAULT_CODES.NOT_PAIRED:
      return 'not_paired'
    case STATION_FAULT_CODES.MISSING_PERMISSION:
      return 'missing_permission'
    default:
      return 'unknown'
  }
}
