'use client'

import { STATION_COPY } from '@/lib/stations/copy'

/** Shown in place of the board when GET /api/terminal/station-lines 403s (flag off). */
export function StationNotEnabled() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6" data-testid="station-not-enabled">
      <div className="max-w-sm rounded-2xl border border-[#E9E9E7] bg-white p-6 text-center">
        <h1 className="font-serif text-xl font-semibold text-[#37352F]">{STATION_COPY.notEnabled.heading}</h1>
        <p className="mt-2 text-sm text-[#6B675F]">{STATION_COPY.notEnabled.description}</p>
      </div>
    </div>
  )
}
