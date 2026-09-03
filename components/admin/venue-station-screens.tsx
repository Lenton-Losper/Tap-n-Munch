import Link from 'next/link'
import { VENUE_LAUNCHER_COPY as COPY } from '@/lib/stations/venue-launcher-copy'
import { STATION_PWA } from '@/lib/stations/pwa'
import { stationHrefWithVenueHint } from '@/lib/stations/venue-hint'
import type { StationKind } from '@/lib/stations/station-pairing'

export type VenueStationScreen = {
  id: string
  stationKind: StationKind
  name: string | null
  status: string | null
  active: boolean
  lastSeenAt: string | null
  activatedAt: string | null
  /** #373: what bundle/build this screen is actually running. null until it has beaten once. */
  appVersion?: string | null
}

/** Online on the same 15-minute rule the venue page already applies to every other terminal. */
const ONLINE_WINDOW_MS = 15 * 60 * 1000

function screenState(screen: VenueStationScreen, now: number): string {
  if (screen.status === 'revoked' || !screen.active) return COPY.revoked
  if (!screen.activatedAt) return COPY.awaitingActivation
  if (!screen.lastSeenAt) return COPY.neverSeen
  const seen = new Date(screen.lastSeenAt).getTime()
  if (!Number.isFinite(seen)) return COPY.neverSeen
  if (now - seen < ONLINE_WINDOW_MS) return COPY.seenRecently
  return COPY.seenAt(new Date(seen).toLocaleString())
}

/**
 * WHICH SCREENS THIS VENUE HAS, ON THE VENUE'S OWN PAGE.
 *
 * See lib/stations/venue-launcher-copy.ts for why this exists and what it deliberately does not
 * claim. In short: a wrong pairing used to be discoverable only from the wall, where it looks
 * identical to a quiet shift. This makes it visible from the dashboard.
 *
 * Server component: it renders from the page's own already-authorised query and adds no endpoint,
 * no client fetch, and no new way to ask which screens a venue has.
 */
export function VenueStationScreens({
  screens,
  venueId,
  venueName,
  now = Date.now(),
}: {
  screens: VenueStationScreen[]
  /**
   * Passed onto the Open link as a HINT so the board can tell the operator when the device it
   * lands on belongs to a different venue. It grants nothing and never scopes anything — see
   * lib/stations/venue-hint.ts. Optional so the panel still renders without it.
   */
  venueId?: string | null
  venueName?: string | null
  now?: number
}) {
  const stations: Array<{ kind: StationKind; label: string; open: string }> = [
    { kind: 'kitchen', label: COPY.kitchenLabel, open: COPY.openKitchen },
    { kind: 'bar', label: COPY.barLabel, open: COPY.openBar },
  ]

  return (
    <div data-testid="venue-station-screens" className="space-y-4">
      {stations.map(({ kind, label, open }) => {
        // Only screens that are actually usable count as "paired" for this station: a revoked row
        // stays in the table for its history but must not read as a working screen.
        const paired = screens.filter((s) => s.stationKind === kind && s.active && s.status !== 'revoked')
        return (
          <div
            key={kind}
            data-testid={`venue-station-${kind}`}
            data-paired-count={paired.length}
            className="rounded-lg border border-[#E8E6E1] p-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#1A1A1A]">{label}</div>
                {paired.length === 0 ? (
                  <div className="mt-1">
                    <div className="text-sm text-[#B0341F]">{COPY.nonePaired}</div>
                    <div className="mt-0.5 text-xs text-[#8A867C]">{COPY.nonePairedHint}</div>
                  </div>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {paired.map((s) => (
                      <li key={s.id} data-testid="venue-station-screen-row" className="text-xs text-[#8A867C]">
                        <span className="text-[#1A1A1A]">{s.name || label}</span> · {screenState(s, now)}
                        {' · '}
                        {/*
                          #373: a screen that has never reported is not the same as one running an
                          old build, and "unknown" says which. Before this, EVERY station screen
                          read null and the field was useless.
                        */}
                        <span data-testid="screen-version">{s.appVersion?.trim() || COPY.versionUnknown}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Link
                href={
                  venueId
                    ? stationHrefWithVenueHint(STATION_PWA[kind].startUrl, venueId, venueName ?? null)
                    : STATION_PWA[kind].startUrl
                }
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`venue-open-${kind}`}
                className="shrink-0 rounded-lg bg-[#37352F] px-3 py-2 text-xs font-medium text-white hover:bg-[#4A4740]"
              >
                {open}
              </Link>
            </div>

            {paired.length > 1 ? (
              <p data-testid={`venue-station-${kind}-multiple`} className="mt-3 text-xs text-[#8A6D3B]">
                {COPY.multiplePaired(label)}
              </p>
            ) : null}
          </div>
        )
      })}

      {/* Said once for the panel, not per button: it is the same caveat for both. */}
      <p className="text-xs leading-relaxed text-[#8A867C]">{COPY.openNote}</p>
    </div>
  )
}
