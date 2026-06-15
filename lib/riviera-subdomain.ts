export const RIVIERA_HOST = 'riviera.flashtap.app'

export const RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

export const RIVIERA_MENU_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/v2`

export function isRivieraHost(hostHeader: string | null): boolean {
  const host = String(hostHeader || '')
    .split(':')[0]
    .toLowerCase()
  return host === RIVIERA_HOST
}
