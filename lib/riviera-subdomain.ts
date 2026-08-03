export const RIVIERA_HOST = 'riviera.flashtap.app'

export const RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

export const RIVIERA_MENU_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/browse`

/** Landing page a table QR resolves to, under the real /menu layout. */
export const RIVIERA_TABLE_LANDING_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/v2`

/**
 * Table number from a `/table/{n}` pathname, or null when it isn't one.
 * Only positive integers count -- `/table/abc` and `/table/0` are not tables.
 */
export function parseTableLandingPath(pathname: string): number | null {
  const match = /^\/table\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  const tableNumber = Number(match[1])
  if (!Number.isInteger(tableNumber) || tableNumber <= 0) return null
  return tableNumber
}

export function isRivieraHost(hostHeader: string | null): boolean {
  const host = String(hostHeader || '')
    .split(':')[0]
    .toLowerCase()
  return host === RIVIERA_HOST
}
