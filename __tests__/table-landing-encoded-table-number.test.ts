/**
 * Issue #179 — `riviera.flashtap.app/table/N` is the QR entry point, the first thing a customer
 * touches after scanning a printed code, so anything it fails to route is a scan that appears
 * to do nothing.
 *
 * `parseTableLandingPath` read the raw path segment and never decoded it. `/table/%205` is the
 * percent-encoding of `/table/ 5` — table 5 with a stray leading space — and `Number("%205")`
 * is NaN, so the rewrite never fired for a table number that is perfectly valid once decoded.
 *
 * WHAT THIS DOES NOT CHANGE. The integer rule is untouched: a fractional table number is not a
 * table, so `/table/5.5` still routes nowhere. The bug being fixed is that the segment was
 * never DECODED — not that the set of accepted numbers was too small. `%205` already IS 5;
 * refusing it was a parsing defect, not a policy about what counts as a table.
 *
 * HOW "not routed anywhere" IS ESTABLISHED — read before trusting those assertions. Jest cannot
 * ask Next for an HTTP status, so these assert only half of it: that the real middleware, driven
 * with a real NextRequest, issues no rewrite and no redirect. What serves the path afterwards is
 * a separate question, and on THIS branch the answer is not a 404 — see the note below.
 *
 * ON THIS BRANCH `app/table/[tableNumber]/page.tsx` STILL EXISTS. #118 deleted it, but that
 * commit (382389b) is on origin/main and has never been cherry-picked to cloudflare-staging. So
 * an unrewritten `/table/5.5` here does not 404 — it reaches that page, which renders the v2
 * landing outside `app/menu/[restaurantId]/layout.tsx`, so TabProvider is never mounted and
 * useTab() throws on mount. A blank screen rather than a 404. That is #118's residual, not
 * #179's, and it is why these tests assert middleware behaviour only and claim nothing about
 * the status code.
 *
 * The positive controls are not decoration. A negative-only version of this file would pass
 * just as happily against a middleware whose rewrite was broken entirely — every path would
 * route nowhere, including every printed QR.
 */
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { parseTableLandingPath, RIVIERA_TABLE_LANDING_PATH } from '@/lib/riviera-subdomain'

const RIVIERA_HOST = 'riviera.flashtap.app'
const OTHER_HOST = 'flashtap.app'

type Routed =
  | { kind: 'rewrite'; pathname: string; table: string | null }
  | { kind: 'redirect'; location: string }
  | { kind: 'fallthrough' }

/** What the real middleware does with this request. */
async function route(host: string, path: string): Promise<Routed> {
  const req = new NextRequest(new URL(`https://${host}${path}`), { headers: { host } })
  const res = await middleware(req)

  const rewrite = res.headers.get('x-middleware-rewrite')
  if (rewrite) {
    const url = new URL(rewrite)
    return { kind: 'rewrite', pathname: url.pathname, table: url.searchParams.get('table') }
  }

  const location = res.headers.get('location')
  if (location) return { kind: 'redirect', location }

  return { kind: 'fallthrough' }
}

/** Unchanged shapes: what a printed QR produces, plus coercions that already reached table 5. */
const ALREADY_WORKING: Array<[string, string]> = [
  ['/table/1', '1'],
  ['/table/5', '5'],
  ['/table/05', '5'],
  ['/table/5.0', '5'],
  ['/table/5e0', '5'],
  ['/table/+5', '5'],
]

/**
 * The #179 gap: a valid integer table number that survived a round of percent-encoding. Each
 * decodes to whitespace around a number that was always acceptable.
 */
const ENCODED_WHITESPACE: Array<[string, string]> = [
  ['/table/%205', '5'],      // leading space
  ['/table/5%20', '5'],      // trailing space
  ['/table/%2012', '12'],    // more than one digit
  ['/table/%2005', '5'],     // and still coerced like the bare form
  ['/table/%C2%A05', '5'],   // non-breaking space, which a copy-paste or a label tool can insert
]

/** Still not table numbers. The integer rule is deliberately unchanged by #179. */
const STILL_NOT_TABLES = [
  '/table/5.5',
  '/table/0.5',
  '/table/1e-3',
  '/table/%205.5',   // decoding does not promote a fraction to a table
  '/table/abc',
  '/table/%20abc',
  '/table/0',
  '/table/%200',
  '/table/-3',
  '/table/Infinity',
  '/table/',
  '/table/%20',      // whitespace and nothing else
  '/table/5/extra',
]

describe('positive control: the shapes that already routed still route (#179)', () => {
  it.each(ALREADY_WORKING)('%s still rewrites into the menu tree at table %s', async (path, table) => {
    expect(await route(RIVIERA_HOST, path)).toEqual({
      kind: 'rewrite',
      pathname: RIVIERA_TABLE_LANDING_PATH,
      table,
    })
  })

  it('the bare Riviera root still rewrites to the menu', async () => {
    expect((await route(RIVIERA_HOST, '/')).kind).toBe('rewrite')
  })
})

describe('an encoded space around a valid table number now routes (#179)', () => {
  it.each(ENCODED_WHITESPACE)('%s rewrites into the menu tree at table %s', async (path, table) => {
    expect(await route(RIVIERA_HOST, path)).toEqual({
      kind: 'rewrite',
      pathname: RIVIERA_TABLE_LANDING_PATH,
      table,
    })
  })

  it('resolves to the number itself, not the encoded text, so nothing raw reaches the URL', () => {
    // The parser returns a NUMBER and the middleware stringifies THAT into ?table=. The decoded
    // segment is never substituted into a path, which is why decoding cannot smuggle anything:
    // an encoded slash decodes to a non-number and is refused outright.
    expect(parseTableLandingPath('/table/%205')).toBe(5)
    expect(parseTableLandingPath('/table/%2F5')).toBeNull()
    expect(parseTableLandingPath('/table/%2E%2E')).toBeNull()
  })
})

describe('a fraction is still not a table number (#179 changes the decoding, not the rule)', () => {
  it.each(STILL_NOT_TABLES)('%s is not rewritten', async (path) => {
    expect(await route(RIVIERA_HOST, path)).toEqual({ kind: 'fallthrough' })
  })
})

describe('malformed encoding is refused rather than thrown', () => {
  // decodeURIComponent throws URIError on a stray %, and this runs in middleware on every
  // request to the QR host -- a throw here is a 500 on the entry point, which is worse than
  // the miss it would be replacing.
  const MALFORMED = ['/table/%', '/table/%zz', '/table/%E0%A4%A', '/table/5%']

  it.each(MALFORMED)('%s returns null instead of throwing', (path) => {
    expect(() => parseTableLandingPath(path)).not.toThrow()
    expect(parseTableLandingPath(path)).toBeNull()
  })

  it.each(MALFORMED)('%s routes nowhere instead of erroring the middleware', async (path) => {
    await expect(route(RIVIERA_HOST, path)).resolves.toEqual({ kind: 'fallthrough' })
  })
})

describe('other hosts are unaffected by the decoding change', () => {
  it.each([...ALREADY_WORKING.map(([p]) => p), ...ENCODED_WHITESPACE.map(([p]) => p)])(
    '%s is not rewritten off the Riviera host',
    async (path) => {
      // The subdomain rewrite is host-gated. Decoding must not become a way to reach Riviera's
      // menu from another tenant's domain.
      expect(await route(OTHER_HOST, path)).toEqual({ kind: 'fallthrough' })
    },
  )
})
