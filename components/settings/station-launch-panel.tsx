'use client'

import { STATION_PAIRING_COPY as COPY } from '@/lib/stations/pairing-copy'
import { STATION_PWA } from '@/lib/stations/pwa'

/**
 * HOW A SCREEN STOPS BEING A TYPED URL.
 *
 * ============================================================================================
 * WHY THIS SITS INSIDE THE PAIRING SECTION AND NOT ON ITS OWN PAGE
 * ============================================================================================
 *
 * Installing and pairing are one job done once, by one person, standing at one screen. Splitting
 * them across two places is how you get a screen that is installed but paired to the wrong venue —
 * which is exactly what happened at Riviera on 2026-09-02, when a kitchen screen was paired with a
 * code generated from a different venue's page and nothing said so for 45 minutes.
 *
 * ============================================================================================
 * THE LINKS ARE PLAIN, AND THAT IS THE POINT
 * ============================================================================================
 *
 * `/kitchen` and `/bar` carry no restaurant, no terminal id and no token. Which venue a board shows
 * is decided by the terminal JWT that device already holds, and the server re-checks the station
 * against restaurant_terminals.station_kind on every request. So these anchors cannot grant
 * anything: they are a door, not a key. Opening one on an unpaired machine lands on the activation
 * gate, which is the correct outcome rather than a leak.
 */
export function StationLaunchPanel() {
  const stations = [
    { kind: 'kitchen' as const, label: COPY.launch.openKitchen },
    { kind: 'bar' as const, label: COPY.launch.openBar },
  ]

  return (
    <div className="rounded-xl border border-[#E8E6E1] bg-white p-5" data-testid="station-launch-panel">
      <h3 className="text-base font-semibold text-[#1A1A1A]">{COPY.launch.heading}</h3>
      <p className="mt-1 text-sm leading-relaxed text-[#6B675F]">{COPY.launch.body}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        {stations.map(({ kind, label }) => (
          <a
            key={kind}
            href={STATION_PWA[kind].startUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`launch-${kind}`}
            data-station={kind}
            className="inline-flex items-center gap-2 rounded-lg bg-[#37352F] px-4 py-2 text-sm font-medium text-white hover:bg-[#4A4740]"
          >
            {label}
          </a>
        ))}
      </div>

      <div className="mt-5 rounded-lg bg-[#FAFAF8] p-4">
        <p className="text-sm font-medium text-[#37352F]">{COPY.launch.installHeading}</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[#6B675F]">
          {COPY.launch.installSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      {/* The two things an installer gets wrong, said before they get them wrong. */}
      <p className="mt-4 text-sm text-[#6B675F]">{COPY.launch.pairingNote}</p>
      <p className="mt-2 text-sm text-[#6B675F]">{COPY.launch.venueNote}</p>
    </div>
  )
}
