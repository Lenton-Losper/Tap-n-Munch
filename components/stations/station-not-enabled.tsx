'use client'

import { STATION_COPY } from '@/lib/stations/copy'

/**
 * Shown in place of the board when the initial fetch 403s. Two distinct causes share this shell
 * (see lib/stations/copy.ts): stationScreensEnabled off venue-wide (`notEnabled`, the default),
 * or this specific terminal not paired to this screen (`notPaired`, when `reason` is set).
 */
export function StationNotEnabled({
  reason = 'not_enabled',
  pairedTo = null,
}: {
  reason?: 'not_enabled' | 'not_paired'
  pairedTo?: string | null
}) {
  const heading =
    reason === 'not_paired' ? STATION_COPY.notPaired.heading : STATION_COPY.notEnabled.heading
  const description =
    reason === 'not_paired'
      ? STATION_COPY.notPaired.description(pairedTo)
      : STATION_COPY.notEnabled.description

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6" data-testid="station-not-enabled">
      <div className="max-w-sm rounded-2xl border border-[#E9E9E7] bg-white p-6 text-center">
        <h1 className="font-serif text-xl font-semibold text-[#37352F]">{heading}</h1>
        <p className="mt-2 text-sm text-[#6B675F]">{description}</p>
      </div>
    </div>
  )
}
