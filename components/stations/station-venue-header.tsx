'use client'

import { STATION_COPY } from '@/lib/stations/copy'
import type { StationKind } from '@/lib/stations/station-pairing'

/**
 * WHAT THIS SCREEN IS, AND WHOSE ORDERS IT IS SHOWING (#371).
 *
 * The board used to head itself with one word — "Kitchen" — and nothing anywhere on the page said
 * which restaurant that kitchen belonged to. A screen paired to the wrong venue therefore looked
 * exactly like a screen with nothing to do: both read "Nothing waiting".
 *
 * The venue is rendered at the same size as the station, not as a subtitle, because the failure
 * this exists to catch is someone glancing at a wall from three metres away and seeing an empty
 * board. A caption they have to walk over to read would not have caught it.
 *
 * The name comes from the TERMINAL SESSION — written at activation from the server's response for
 * that token — never from the URL. A screen cannot be talked into claiming a venue by its address
 * bar.
 */
export function StationVenueHeader({
  station,
  venueName,
}: {
  station: StationKind
  venueName: string | null
}) {
  const stationLabel = station === 'kitchen' ? STATION_COPY.kitchen.pageTitle : STATION_COPY.bar.pageTitle
  const name = (venueName ?? '').trim()

  return (
    <h1
      className="font-serif text-2xl font-bold text-[#37352F]"
      data-testid="station-venue-header"
      data-station={station}
      data-venue={name || 'unknown'}
    >
      {stationLabel}
      <span className="mx-2 font-normal text-[#B8B5AD]" aria-hidden="true">
        ·
      </span>
      {name ? (
        <span className="font-normal text-[#6B675F]">{name}</span>
      ) : (
        /* Never blank. An unnamed venue is a fact worth showing, and it is recoverable. */
        <span className="font-normal text-[#B0341F]">{STATION_COPY.venue.unknownName}</span>
      )}
    </h1>
  )
}
