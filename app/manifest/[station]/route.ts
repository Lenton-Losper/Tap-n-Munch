import { NextResponse } from 'next/server'
import { isStationKind, type StationKind } from '@/lib/stations/station-pairing'
import { STATION_PWA } from '@/lib/stations/pwa'

export const dynamic = 'force-static'

/**
 * ONE WEB MANIFEST PER STATION — THE WHOLE REASON THIS IS A ROUTE AND NOT `app/manifest.ts`.
 *
 * ============================================================================================
 * WHY TWO MANIFESTS AND NOT ONE
 * ============================================================================================
 *
 * Chrome keys an installed app on the manifest's `id` (falling back to `start_url`). One manifest
 * can therefore only ever install as ONE application. The requirement is two recognisable icons on
 * a Windows desktop — "FlashTap Kitchen" and "FlashTap Bar" — each opening straight into its own
 * board, so there must be two manifests with two ids, two names and two start_urls.
 *
 * Next's conventional `app/manifest.ts` produces exactly one document at /manifest.webmanifest,
 * which is why this is a route with a station parameter instead.
 *
 * ============================================================================================
 * THE URL CARRIES THE STATION, NEVER THE RESTAURANT
 * ============================================================================================
 *
 * `start_url` is `/kitchen` or `/bar` and nothing else. Which VENUE that board shows is decided by
 * the terminal JWT the device already holds (lib/stations/use-terminal-session.ts), exactly as it
 * is for a hand-typed URL — the installed app is the same page reached by a different door, and it
 * gets no additional authority.
 *
 * Putting a restaurant id in start_url would make the identity of a venue a thing anyone could
 * edit in a shortcut's properties, and would hand a wrong-venue pairing a second way to happen.
 * The station IS in the URL because it always has been, and because the server re-checks it
 * against restaurant_terminals.station_kind on every request (assertTerminalPairedToStation) --
 * a device cannot promote itself by opening the other icon.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ station: string }> }) {
  const { station: raw } = await params
  const station = String(raw ?? '')
    .replace(/\.webmanifest$/, '')
    .trim()
    .toLowerCase()

  if (!isStationKind(station)) {
    return NextResponse.json({ error: 'Unknown station' }, { status: 404 })
  }

  const config = STATION_PWA[station as StationKind]

  return NextResponse.json(
    {
      // Distinct id per station: this is what makes Chrome treat them as two applications.
      id: config.startUrl,
      name: config.name,
      short_name: config.shortName,
      description: config.description,
      start_url: config.startUrl,
      /**
       * Scoped to the station's own path. A tap that would navigate outside the board opens a
       * normal browser window instead of silently replacing the pass with some other page -- the
       * closest thing to kiosk behaviour that needs no device administration, and it still leaves
       * the app fully usable when the machine is NOT locked down.
       */
      scope: config.startUrl,
      display: 'standalone',
      orientation: 'landscape',
      background_color: config.backgroundColor,
      theme_color: config.themeColor,
      icons: [
        {
          src: `/icons/${station}-192.png`,
          sizes: '192x192',
          type: 'image/png',
          // The glyph sits inside ~60% of the canvas, so the same file survives maskable cropping.
          purpose: 'any maskable',
        },
        {
          src: `/icons/${station}-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
