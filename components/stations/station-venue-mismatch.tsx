'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import { StationVenueHeader } from '@/components/stations/station-venue-header'
import type { StationKind } from '@/lib/stations/station-pairing'

/**
 * THE DASHBOARD SAID ONE VENUE, THE TOKEN RESOLVED TO ANOTHER.
 *
 * See lib/stations/venue-hint.ts for why the hint exists and what it deliberately is not. In
 * short: opening a station from a venue's dashboard did not fix the wrong-venue failure, it only
 * moved its entrance. A browser holding one venue's token, clicked from another venue's page,
 * lands on a correct board that looks exactly like a quiet shift at the venue you expected.
 *
 * NOT STYLED AS AN ERROR. Nothing has failed — the board is right, the token says so, and the food
 * on it is real. Only the expectation is wrong. Amber, not red: red would send someone hunting a
 * fault that does not exist.
 *
 * The venue header sits above it exactly as it does on a working board, so the answer to "whose
 * board is this?" is in the same place it always is.
 */
export function StationVenueMismatch({
  station,
  showingVenueName,
  openedFromVenueName,
  onContinue,
}: {
  station: StationKind
  /** From the session. Authoritative. */
  showingVenueName: string | null
  /** From the link. Quoted back, never trusted for anything else. */
  openedFromVenueName: string | null
  onContinue: () => void
}) {
  const copy = STATION_COPY.venueMismatch
  const showing = (showingVenueName ?? '').trim() || STATION_COPY.venue.unknownName
  const openedFrom = (openedFromVenueName ?? '').trim() || copy.unknownOpenedFrom

  return (
    <div
      className="flex min-h-screen flex-col bg-[#FAFAF8] p-6"
      data-testid="station-venue-mismatch"
      data-showing={showing}
    >
      <StationVenueHeader station={station} venueName={showingVenueName} />
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-xl rounded-2xl border-2 border-[#D9A441] bg-white p-8 text-center">
          <h2 className="font-serif text-2xl font-semibold text-[#37352F]">{copy.heading}</h2>
          <p className="mt-3 text-lg leading-relaxed text-[#37352F]">{copy.body(showing, openedFrom)}</p>
          <p className="mt-3 text-base leading-relaxed text-[#6B675F]">{copy.fix}</p>
          <button
            type="button"
            onClick={onContinue}
            data-testid="mismatch-continue"
            className="mt-6 rounded-lg bg-[#37352F] px-5 py-2 text-base font-medium text-white hover:bg-[#4A4740]"
          >
            {copy.continueButton}
          </button>
        </div>
      </div>
    </div>
  )
}
