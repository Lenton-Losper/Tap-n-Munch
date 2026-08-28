'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import type { FeedConnectionState } from '@/lib/dashboard/realtime-connection'

const DOT_CLASSES: Record<FeedConnectionState, string> = {
  live: 'bg-green-500',
  reconnecting: 'bg-amber-500',
  offline: 'bg-red-500',
}

/**
 * #350's resilience layer, reused rather than duplicated: this only renders the state
 * lib/dashboard/realtime-connection.ts computes (see lib/stations/realtime.ts for how a
 * station screen's SSE connection feeds that same module). Same three-state shape and the same
 * rule feed-connection-copy.ts documents — copy is drafted fresh for this surface in
 * lib/stations/copy.ts because "lines"/"board" fits this screen where "orders" would not.
 */
export function StationConnectionIndicator({ state }: { state: FeedConnectionState }) {
  const label = STATION_COPY.connection[state]

  return (
    <div
      data-testid="station-connection-indicator"
      data-connection-state={state}
      aria-label={label}
      title={label}
      className="flex items-center gap-2 rounded-full border border-[#E9E9E7] bg-white px-3 py-1.5 text-xs text-[#37352F]"
    >
      <span className={`h-2 w-2 rounded-full ${DOT_CLASSES[state]}`} />
      <span>{label}</span>
    </div>
  )
}
