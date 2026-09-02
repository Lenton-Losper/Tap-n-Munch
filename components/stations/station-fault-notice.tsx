'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import type { StationFault } from '@/lib/stations/faults'
import { StationVenueHeader } from '@/components/stations/station-venue-header'
import type { StationKind } from '@/lib/stations/station-pairing'

/**
 * Shown in place of the board when it cannot load. ONE MESSAGE PER DISTINCT FAULT (#370).
 *
 * This replaces `StationNotEnabled`, which took a two-value `reason` and defaulted everything that
 * was not a pairing mismatch to "station screens are not turned on yet". That default was the
 * defect: it stated a cause the screen had not established, and sent staff to a setting that was
 * usually already correct.
 *
 * `data-fault` carries the fault onto the DOM so a test — or a person looking at a screenshot —
 * can tell the states apart without matching on prose that is expected to be edited.
 */
export function StationFaultNotice({
  fault,
  pairedTo = null,
  station,
  venueName = null,
}: {
  fault: StationFault
  pairedTo?: string | null
  /** #371: a board showing no work must still answer "whose orders is this?". */
  station: StationKind
  venueName?: string | null
}) {
  const copy = STATION_COPY.faults
  const { heading, description } =
    fault === 'not_paired'
      ? { heading: copy.notPaired.heading, description: copy.notPaired.description(pairedTo) }
      : fault === 'screens_disabled'
        ? copy.screensDisabled
        : fault === 'screens_not_configured'
          ? copy.screensNotConfigured
          : fault === 'screens_unavailable'
            ? copy.screensUnavailable
            : fault === 'missing_permission'
              ? copy.missingPermission
              : copy.unknown

  return (
    <div
      className="flex min-h-screen flex-col bg-[#FAFAF8] p-6"
      data-testid="station-fault-notice"
      data-fault={fault}
    >
      {/*
        #371: pinned top-left, the same place and size it sits on a working board. A screen showing
        no work is exactly when someone asks whose orders it is supposed to be showing — a screen
        pointed at the wrong venue and a screen with nothing to do look identical without this.
      */}
      <StationVenueHeader station={station} venueName={venueName} />
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md rounded-2xl border border-[#E9E9E7] bg-white p-8 text-center">
          {/* h2, not h1: StationVenueHeader above is this page's heading. Two h1s on one
              page is wrong for a screen reader and made "find the fault heading" ambiguous. */}
          <h2 className="font-serif text-2xl font-semibold text-[#37352F]" data-testid="station-fault-heading">
            {heading}
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[#6B675F]">{description}</p>
          {(venueName ?? '').trim() ? null : (
            <p className="mt-3 text-base text-[#B0341F]">{STATION_COPY.venue.unknownHelp}</p>
          )}
        </div>
      </div>
    </div>
  )
}
