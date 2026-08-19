export const RIVIERA_HOST = 'riviera.flashtap.app'

export const RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

export const RIVIERA_MENU_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/browse`

/** Landing page a table QR resolves to, under the real /menu layout. */
export const RIVIERA_TABLE_LANDING_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/v2`

/**
 * Table number from a `/table/{n}` pathname, or null when it isn't one.
 * Only positive integers count -- `/table/abc` and `/table/0` are not tables.
 *
 * ============================================================================================
 * #179 — THE SEGMENT IS DECODED FIRST, AND NON-INTEGERS ARE REJECTED HONESTLY
 * ============================================================================================
 *
 * This read `Number(match[1])` on the RAW pathname. Middleware sees `/table/%205` before Next
 * decodes the route param, so `Number("%205")` is NaN, no rewrite happened, and the request fell
 * through to a page that rendered the landing OUTSIDE the provider tree, where `useTab()` throws
 * on mount. Next then decoded the param to `" 5"`, which `Number()` reads as 5.
 *
 * A VALID TABLE NUMBER TAKING A PATH THAT DOES NOT RESOLVE. `/table/5.5`, `/table/0.5` and
 * `/table/1e-3` are the same shape.
 *
 * Decoding first is the fix, and it is deliberately the ONLY widening: `5.5` and `1e-3` still
 * return null, because they are not table numbers and pretending otherwise would rewrite to a
 * table that does not exist. What changes is that `%205` now resolves to 5 — the number the
 * customer's QR actually encoded — rather than silently missing the rewrite.
 *
 * `decodeURIComponent` throws on a malformed sequence (`/table/%E0%A4%A`), which is a
 * not-a-table-number answer like any other, so it is caught and returned as null rather than
 * allowed to 500 the middleware.
 *
 * The trim matters for the same reason: decoding `%20` yields a leading space, and while
 * `Number(" 5")` happens to be 5, `Number.isInteger` is being asked about the value the customer
 * meant, so the whitespace is removed before it is read rather than relied upon to be ignored.
 * An empty segment after trimming is null — `Number("")` is 0, which would otherwise sail past
 * `Number.isInteger` and be caught only by the `> 0` test, for the wrong reason.
 */
export function parseTableLandingPath(pathname: string): number | null {
  const match = /^\/table\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null

  let raw: string
  try {
    raw = decodeURIComponent(match[1])
  } catch {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) return null

  const tableNumber = Number(trimmed)
  if (!Number.isInteger(tableNumber) || tableNumber <= 0) return null
  return tableNumber
}

export function isRivieraHost(hostHeader: string | null): boolean {
  const host = String(hostHeader || '')
    .split(':')[0]
    .toLowerCase()
  return host === RIVIERA_HOST
}
