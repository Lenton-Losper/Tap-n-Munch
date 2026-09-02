import type { StationKind } from '@/lib/stations/station-pairing'

/**
 * THE TWO INSTALLED APPLICATIONS, DESCRIBED ONCE (#one-click launch).
 *
 * Staff were typing `flashtap.app/kitchen` by hand. That is how a screen standing in Riviera ended
 * up paired to another venue on 2026-09-02, and it is not something a kitchen should ever have to
 * do. Chrome on Windows installs a web app per manifest, so two manifests give two desktop icons.
 *
 * EVERY USER-FACING STRING FOR THE LAUNCHER LIVES HERE, beside the copy module's own convention.
 * `name` is what appears under the Windows icon and in the taskbar, so it carries the product name;
 * `shortName` is what Chrome falls back to when space is tight and is the word the room already
 * uses.
 */
export type StationPwaConfig = {
  /** Shown under the desktop icon. Must say which product AND which station. */
  name: string
  /** Chrome's short form. One word, the one staff already say. */
  shortName: string
  description: string
  /** The path the icon opens. Station only — never a restaurant id. See the manifest route. */
  startUrl: string
  themeColor: string
  backgroundColor: string
}

export const STATION_PWA: Record<StationKind, StationPwaConfig> = {
  kitchen: {
    name: 'FlashTap Kitchen',
    shortName: 'Kitchen',
    description: 'The kitchen pass: what to make, what is ready, and how long it has been waiting.',
    startUrl: '/kitchen',
    // Matches the board's own surface, so the splash does not flash a different colour on launch.
    themeColor: '#37352F',
    backgroundColor: '#F5F4F0',
  },
  bar: {
    name: 'FlashTap Bar',
    shortName: 'Bar',
    description: 'The bar pass: what to pour, what is ready, and how long it has been waiting.',
    startUrl: '/bar',
    themeColor: '#37352F',
    backgroundColor: '#F5F4F0',
  },
}

export function stationPwaManifestUrl(station: StationKind): string {
  return `/manifest/${station}`
}
