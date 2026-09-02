import type { Metadata } from 'next'
import { STATION_PWA, stationPwaManifestUrl } from '@/lib/stations/pwa'

/**
 * THE ONE LINE THAT MAKES THIS PAGE INSTALLABLE AS ITS OWN APPLICATION.
 *
 * Chrome reads <link rel="manifest"> from the page it is looking at, so /kitchen must point at
 * its own manifest and /bar at the other. A single site-wide manifest would install once,
 * under one name, and both desktop icons would open the same board.
 *
 * A layout, not the page: app/kitchen/page.tsx is a client component ('use client') and cannot
 * export metadata.
 */
export const metadata: Metadata = {
  title: STATION_PWA.kitchen.name,
  description: STATION_PWA.kitchen.description,
  manifest: stationPwaManifestUrl('kitchen'),
  applicationName: STATION_PWA.kitchen.name,
  appleWebApp: { capable: true, title: STATION_PWA.kitchen.shortName, statusBarStyle: 'default' },
}

export const viewport = {
  themeColor: STATION_PWA.kitchen.themeColor,
}

export default function KitchenStationLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
