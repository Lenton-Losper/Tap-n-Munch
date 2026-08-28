'use client'

import { STATION_COPY } from '@/lib/stations/copy'

/**
 * Shown from mount until the first board fetch resolves. See lib/stations/copy.ts's docblock on
 * `loading` for why this exists as its own state rather than letting the initial empty
 * `lines`/`rounds` array render the same "Nothing waiting" copy a genuinely empty board would.
 */
export function StationLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6" data-testid="station-loading">
      <p className="text-sm text-[#6B675F]">{STATION_COPY.loading.heading}</p>
    </div>
  )
}
