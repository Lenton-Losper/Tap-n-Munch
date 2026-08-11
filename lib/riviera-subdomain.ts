export const RIVIERA_HOST = 'riviera.flashtap.app'

export const RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

export const RIVIERA_MENU_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/browse`

/** Landing page a table QR resolves to, under the real /menu layout. */
export const RIVIERA_TABLE_LANDING_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/v2`

/**
 * Table number from a `/table/{n}` pathname, or null when it isn't one.
 * Only positive integers count -- `/table/abc` and `/table/0` are not tables.
 *
 * THE SEGMENT IS PERCENT-DECODED FIRST (#179). A pathname carries the RAW segment, so
 * `/table/%205` -- table 5 with a stray leading space -- arrived here as the literal "%205"
 * and `Number("%205")` is NaN, so no rewrite fired for a table number that is perfectly valid
 * once decoded. This is the QR entry point, the first thing a customer touches after scanning
 * a printed code, so a miss here is a scan that appears to do nothing.
 *
 * The integer rule above is deliberately UNCHANGED. A fractional table number is not a table,
 * so `/table/5.5` still returns null. What was broken was the decoding, not the range: `%205`
 * already IS 5, and refusing it was a parsing defect rather than a judgement about what counts
 * as a table.
 *
 * Malformed escapes are refused, not thrown. decodeURIComponent raises URIError on a stray `%`,
 * and this runs in middleware on every request to the QR host -- an uncaught throw here is a
 * 500 on the entry point, which is worse than the missed rewrite it would replace.
 *
 * Decoding cannot smuggle anything into the rewrite: what leaves this function is a NUMBER, and
 * the caller stringifies that into `?table=`. The decoded text is never substituted into a
 * path, and anything that decodes to a non-number (`%2F5` -> "/5") is refused outright.
 */
export function parseTableLandingPath(pathname: string): number | null {
  const match = /^\/table\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null

  let segment: string
  try {
    segment = decodeURIComponent(match[1])
  } catch {
    return null
  }

  const tableNumber = Number(segment.trim())
  if (!Number.isInteger(tableNumber) || tableNumber <= 0) return null
  return tableNumber
}

export function isRivieraHost(hostHeader: string | null): boolean {
  const host = String(hostHeader || '')
    .split(':')[0]
    .toLowerCase()
  return host === RIVIERA_HOST
}
