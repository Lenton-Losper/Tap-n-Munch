'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import type { StationFault } from '@/lib/stations/faults'

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
}: {
  fault: StationFault
  pairedTo?: string | null
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
      className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6"
      data-testid="station-fault-notice"
      data-fault={fault}
    >
      <div className="max-w-md rounded-2xl border border-[#E9E9E7] bg-white p-8 text-center">
        <h1 className="font-serif text-2xl font-semibold text-[#37352F]">{heading}</h1>
        <p className="mt-3 text-base leading-relaxed text-[#6B675F]">{description}</p>
      </div>
    </div>
  )
}
