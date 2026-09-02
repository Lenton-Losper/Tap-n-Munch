import type { Metadata } from 'next'
import { STATION_PWA, stationPwaManifestUrl } from '@/lib/stations/pwa'

/**
 * THE ONE LINE THAT MAKES THIS PAGE INSTALLABLE AS ITS OWN APPLICATION.
 *
 * Chrome reads <link rel="manifest"> from the page it is looking at, so /bar must point at
 * its own manifest and /kitchen at the other. A single site-wide manifest would install once,
 * under one name, and both desktop icons would open the same board.
 *
 * A layout, not the page: app/bar/page.tsx is a client component ('use client') and cannot
 * export metadata.
 */
export const metadata: Metadata = {
  title: STATION_PWA.bar.name,
  description: STATION_PWA.bar.description,
  manifest: stationPwaManifestUrl('bar'),
  applicationName: STATION_PWA.bar.name,
  appleWebApp: { capable: true, title: STATION_PWA.bar.shortName, statusBarStyle: 'default' },
}

export const viewport = {
  themeColor: STATION_PWA.bar.themeColor,
}

export default function BarStationLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
