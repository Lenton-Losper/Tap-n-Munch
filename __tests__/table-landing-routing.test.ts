/**
 * Issue #118 residual — what `riviera.flashtap.app/table/N` can reach.
 *
 * #118 was fixed by rewriting `/table/N` into the `/menu/[restaurantId]` tree in middleware, so
 * TabProvider and RestaurantProvider are mounted. But `app/table/[tableNumber]/page.tsx` was
 * left behind, still rendering MenuLandingPageV2Content outside that provider tree, and it was
 * NOT dead: `parseTableLandingPath` gates the rewrite on `Number.isInteger(n) && n > 0`, while
 * the page gated itself on `Number.isFinite(n) && n > 0`. Any finite-positive NON-integer
 * cleared the second and never triggered the first.
 *
 * `/table/%205` was the sharp one. Middleware sees the raw `%205`, `Number("%205")` is NaN so
 * there is no rewrite; Next then decodes the param to " 5" and `Number(" 5")` is 5. A perfectly
 * valid table number landing on a page that throws on mount.
 *
 * The page is now deleted, so those shapes 404 instead of rendering a thrown blank screen.
 *
 * HOW THE 404 IS ESTABLISHED — read before trusting these assertions. Jest cannot ask Next for
 * an HTTP status, so a "404" here is the composition of two separately-checked facts:
 *   (1) middleware does not rewrite or redirect the path, proven by driving the real middleware
 *       with a real NextRequest; and
 *   (2) no route file exists under app/table that could serve it, proven against the filesystem.
 * Neither half is sufficient alone. (2) is also what fails if the page is ever reintroduced.
 *
 * The positive controls are not decoration. A negative-only version of this file would pass
 * just as happily against a middleware whose rewrite was broken entirely -- every path would
 * 404, including the printed QRs. So the printed-QR shapes are asserted to rewrite to the real
 * menu path, and that path is asserted to exist on disk.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { RIVIERA_TABLE_LANDING_PATH } from '@/lib/riviera-subdomain'

const RIVIERA_HOST = 'riviera.flashtap.app'
const OTHER_HOST = 'flashtap.app'
const REPO_ROOT = join(__dirname, '..')

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

/** True when nothing under app/table can serve this path -- i.e. it 404s. */
function hasNoTableRoute(): boolean {
  return (
    !existsSync(join(REPO_ROOT, 'app/table/[tableNumber]/page.tsx')) &&
    !existsSync(join(REPO_ROOT, 'app/table/[tableNumber]/route.ts')) &&
    !existsSync(join(REPO_ROOT, 'app/table/page.tsx'))
  )
}

/** The shapes a printed table QR actually produces, plus the coercions that reach the same place. */
const PRINTED_QR_SHAPES: Array<[string, string]> = [
  ['/table/1', '1'],
  ['/table/5', '5'],
  ['/table/05', '5'],
  ['/table/5.0', '5'],
  ['/table/5e0', '5'],
  ['/table/+5', '5'],
]

/** Finite-positive non-integers: cleared the page's guard, never triggered the rewrite. */
const GAP_SHAPES = ['/table/5.5', '/table/0.5', '/table/1e-3', '/table/%205']

/**
 * Never valid table numbers. The page already 404'd these itself, via its own guard or by not
 * matching the route at all -- they are here so the whole shape space is covered in one place.
 */
const NON_TABLE_SHAPES = [
  '/table/abc',
  '/table/0',
  '/table/-3',
  '/table/Infinity',
  '/table/',
  '/table/5/extra',
]

describe('positive control: the printed-QR path still works (#118)', () => {
  it.each(PRINTED_QR_SHAPES)('%s rewrites into the menu tree at table %s', async (path, table) => {
    const result = await route(RIVIERA_HOST, path)
    expect(result).toEqual({
      kind: 'rewrite',
      pathname: RIVIERA_TABLE_LANDING_PATH,
      table,
    })
  })

  it('the rewrite target is a real route, not a rewrite into a void', () => {
    // Without this, every assertion above would still pass if the menu page were deleted.
    expect(existsSync(join(REPO_ROOT, 'app/menu/[restaurantId]/v2/page.tsx'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'app/menu/[restaurantId]/layout.tsx'))).toBe(true)
  })

  it('a trailing slash still reaches the menu, on the trailing-slash variant of the path', async () => {
    // parseTableLandingPath's regex allows the trailing slash, and rewriteUrl.pathname keeps it.
    // Recorded as its own case because the target differs from RIVIERA_TABLE_LANDING_PATH by
    // that slash -- it still resolves to the same route, but a strict equality on the constant
    // would fail here and it should not read as a surprise if it ever does.
    expect(await route(RIVIERA_HOST, '/table/5/')).toEqual({
      kind: 'rewrite',
      pathname: `${RIVIERA_TABLE_LANDING_PATH}/`,
      table: '5',
    })
  })

  it('the bare Riviera root still rewrites to the menu', async () => {
    const result = await route(RIVIERA_HOST, '/')
    expect(result.kind).toBe('rewrite')
  })
})

describe('the non-integer gap now 404s instead of throwing (#118 residual)', () => {
  it.each(GAP_SHAPES)('%s is not routed anywhere', async (path) => {
    // Half one: middleware leaves it alone. This is unchanged and deliberately so -- widening
    // parseTableLandingPath to swallow these would be new behaviour on the QR entry path.
    expect(await route(RIVIERA_HOST, path)).toEqual({ kind: 'fallthrough' })
  })

  it('and nothing under app/table can serve it', () => {
    // Half two, and the half the deletion changed. This is what fails if the page comes back.
    expect(hasNoTableRoute()).toBe(true)
  })
})

describe('shapes that were never table numbers', () => {
  it.each(NON_TABLE_SHAPES)('%s is not rewritten', async (path) => {
    expect(await route(RIVIERA_HOST, path)).toEqual({ kind: 'fallthrough' })
  })
})

describe('other hosts', () => {
  it.each([...PRINTED_QR_SHAPES.map(([p]) => p), ...GAP_SHAPES])(
    '%s is not rewritten off the Riviera host',
    async (path) => {
      // The subdomain rewrite is host-gated, and the deleted page had its own isRivieraHost
      // guard, so these 404 rather than serving Riviera's menu to another tenant's domain.
      expect(await route(OTHER_HOST, path)).toEqual({ kind: 'fallthrough' })
    },
  )
})
