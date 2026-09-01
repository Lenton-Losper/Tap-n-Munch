/**
 * Setting a menu category to route_to 'both' must be a deliberate act, in every write path.
 *
 * ============================================================================================
 * WHAT THIS IS ABOUT
 * ============================================================================================
 *
 * 'both' does not mean "show it at both stations". It means the line is NOT Ready until the
 * kitchen AND the bar have each bumped it — one station finishing cannot release the plate
 * (isLineReady, lib/orders/order-lines.ts). The dropdown said only "Both".
 *
 * 2026-09-01, Digi Cofee: 4x Coffee stuck on "Being made" at the P5 while the bar board showed it
 * done, because Drinks was routed 'both' and the kitchen had never touched it. Read-only audit of
 * production the same day: 72 live items across 7 categories at two venues still route 'both'.
 *
 * ============================================================================================
 * WHAT THESE TESTS PIN, AND WHAT THEY DELIBERATELY DO NOT
 * ============================================================================================
 *
 * They pin the SERVER refusal, in all three branches (POST, PATCH single, PATCH bulk), because
 * that is the guard that actually holds — a client-side disabled button is a convenience, not a
 * control, and a script or an old bundle bypasses it entirely.
 *
 * They equally pin what must KEEP working, because a guard that breaks the two venues currently
 * running 'both' on purpose is a worse defect than the one it fixes:
 *
 *   - kitchen / bar writes take no acknowledgement at all
 *   - renaming a category that is ALREADY 'both' needs none, because that write does not set
 *     route_to
 *   - an acknowledged 'both' still succeeds — the option is not removed
 *
 * The stub APPLIES the update rather than recording the call, so a test cannot pass by the route
 * dropping route_to server-side and something else compensating.
 */
import { POST, PATCH } from '@/app/api/admin/menu/categories/route'
import {
  BOTH_ROUTE_REFUSAL,
  validateCategoryRouteWrite,
} from '@/lib/menu/category-routing'

type Row = Record<string, unknown>

const RESTAURANT = 'rest-routing'

/** Already routed 'both' on purpose — the FNB ChowNow / Mingle shape. */
const EXISTING_BOTH: Row = {
  id: 'cat-both',
  restaurant_id: RESTAURANT,
  name: 'Sides',
  route_to: 'both',
  active: true,
}

const EXISTING_KITCHEN: Row = {
  id: 'cat-kitchen',
  restaurant_id: RESTAURANT,
  name: 'Mains',
  route_to: 'kitchen',
  active: true,
}

let rows: Row[]
/** Every insert/update the route actually performed, so we can assert on the persisted effect. */
let writes: Array<{ kind: 'insert' | 'update'; payload: Row }>

function makeClient() {
  const makeBuilder = (table: string) => {
    const filters: Array<[string, unknown]> = []
    const inFilters: Array<[string, readonly unknown[]]> = []
    let pending: { kind: 'insert' | 'update'; payload: Row } | null = null

    const matching = () =>
      rows.filter(
        (r) =>
          filters.every(([c, v]) => String(r[c] ?? '') === String(v)) &&
          inFilters.every(([c, vs]) => vs.map(String).includes(String(r[c] ?? ''))),
      )

    const resolve = () => {
      if (table !== 'menu_categories') return { data: null, error: { message: `unexpected ${table}` } }
      if (pending?.kind === 'insert') {
        const created = { id: 'cat-new', ...pending.payload }
        rows.push(created)
        writes.push({ kind: 'insert', payload: pending.payload })
        return { data: created, error: null }
      }
      if (pending?.kind === 'update') {
        const hit = matching()
        for (const r of hit) Object.assign(r, pending.payload)
        writes.push({ kind: 'update', payload: pending.payload })
        return { data: hit, error: null }
      }
      return { data: matching(), error: null }
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
      in: (c: string, v: readonly unknown[]) => (inFilters.push([c, v]), builder),
      ilike: (c: string, v: string) => (filters.push([c, v]), builder),
      insert: (payload: Row) => ((pending = { kind: 'insert', payload }), builder),
      update: (payload: Row) => ((pending = { kind: 'update', payload }), builder),
      maybeSingle: () => Promise.resolve({ data: (resolve().data as Row[])?.[0] ?? null, error: null }),
      single: () => {
        const r = resolve()
        return Promise.resolve({
          data: Array.isArray(r.data) ? r.data[0] ?? null : r.data,
          error: r.error,
        })
      },
      then: (onFulfilled: (r: ReturnType<typeof resolve>) => unknown) =>
        Promise.resolve(onFulfilled(resolve())),
    }
    return builder
  }

  return { from: (table: string) => makeBuilder(table) }
}

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-routing' }),
  getRestaurantIdForUser: async () => 'rest-routing',
}))

jest.mock('@/lib/api/menu-route-auth', () => ({
  requireMenuWriteContext: async () => ({
    supabase: makeClientRef.current,
    restaurantId: 'rest-routing',
  }),
  loadCategoryForRestaurant: async (_c: unknown, id: string) =>
    rows.find((r) => String(r.id) === String(id) && String(r.restaurant_id) === 'rest-routing') ??
    null,
}))

const makeClientRef: { current: ReturnType<typeof makeClient> } = { current: null as never }

beforeEach(() => {
  rows = [{ ...EXISTING_BOTH }, { ...EXISTING_KITCHEN }]
  writes = []
  makeClientRef.current = makeClient()
})

const req = (body: unknown) =>
  new Request('https://example.test/api/admin/menu/categories', {
    method: 'POST',
    body: JSON.stringify(body),
  })

async function post(body: unknown) {
  const res = await POST(req(body))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function patch(body: unknown) {
  const res = await PATCH(req(body))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST — creating a category', () => {
  it("refuses route_to 'both' with no acknowledgement, and writes nothing", async () => {
    const r = await post({ name: 'Platters', route_to: 'both' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe(BOTH_ROUTE_REFUSAL)
    expect(writes).toHaveLength(0)
    expect(rows.some((x) => x.name === 'Platters')).toBe(false)
  })

  it("creates 'both' when acknowledged, and PERSISTS route_to 'both'", async () => {
    const r = await post({ name: 'Platters', route_to: 'both', confirm_both: true })
    expect(r.status).toBe(200)
    // The effect, not the call: the option is preserved, not quietly downgraded to kitchen.
    expect(rows.find((x) => x.name === 'Platters')?.route_to).toBe('both')
  })

  it('takes no acknowledgement for kitchen or bar', async () => {
    expect((await post({ name: 'Grill', route_to: 'kitchen' })).status).toBe(200)
    expect((await post({ name: 'Taps', route_to: 'bar' })).status).toBe(200)
    expect(rows.find((x) => x.name === 'Taps')?.route_to).toBe('bar')
  })

  it('defaults to kitchen when route_to is omitted — the default is never both', async () => {
    const r = await post({ name: 'Unspecified' })
    expect(r.status).toBe(200)
    expect(rows.find((x) => x.name === 'Unspecified')?.route_to).toBe('kitchen')
  })

  it('rejects an unrecognised route_to as 400 rather than a raw CHECK violation 500', async () => {
    const r = await post({ name: 'Grill station', route_to: 'grill' })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain("'kitchen'")
    expect(writes).toHaveLength(0)
  })
})

describe('PATCH single — editing one category', () => {
  it("refuses setting an existing kitchen category to 'both' unacknowledged", async () => {
    const r = await patch({ categoryId: 'cat-kitchen', route_to: 'both' })
    expect(r.status).toBe(400)
    expect(rows.find((x) => x.id === 'cat-kitchen')?.route_to).toBe('kitchen')
  })

  it("allows it when acknowledged", async () => {
    const r = await patch({ categoryId: 'cat-kitchen', route_to: 'both', confirm_both: true })
    expect(r.status).toBe(200)
    expect(rows.find((x) => x.id === 'cat-kitchen')?.route_to).toBe('both')
  })

  /**
   * THE COMPATIBILITY CASE. Renaming one of the seven categories already routed 'both' must not
   * demand an acknowledgement — that write does not set route_to at all.
   */
  it("renames a category that is ALREADY 'both' with no acknowledgement, leaving its routing intact", async () => {
    const r = await patch({ categoryId: 'cat-both', name: 'Side dishes' })
    expect(r.status).toBe(200)
    const after = rows.find((x) => x.id === 'cat-both')
    expect(after?.name).toBe('Side dishes')
    expect(after?.route_to).toBe('both')
  })

  it('accepts the camelCase acknowledgement too', async () => {
    const r = await patch({ categoryId: 'cat-kitchen', routeTo: 'both', confirmBoth: true })
    expect(r.status).toBe(200)
    expect(rows.find((x) => x.id === 'cat-kitchen')?.route_to).toBe('both')
  })
})

describe('PATCH bulk — the highest-blast-radius path', () => {
  it("refuses an unacknowledged bulk move to 'both' and leaves every row alone", async () => {
    const r = await patch({ categoryIds: ['cat-kitchen', 'cat-both'], route_to: 'both' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe(BOTH_ROUTE_REFUSAL)
    expect(rows.find((x) => x.id === 'cat-kitchen')?.route_to).toBe('kitchen')
    expect(writes).toHaveLength(0)
  })

  it('allows an acknowledged bulk move, and reports the count', async () => {
    const r = await patch({
      categoryIds: ['cat-kitchen', 'cat-both'],
      route_to: 'both',
      confirm_both: true,
    })
    expect(r.status).toBe(200)
    expect(r.body.updatedCount).toBe(2)
    expect(rows.every((x) => x.route_to === 'both')).toBe(true)
  })

  it('needs no acknowledgement to bulk-move AWAY from both — the fix direction is never gated', async () => {
    const r = await patch({ categoryIds: ['cat-both'], route_to: 'bar' })
    expect(r.status).toBe(200)
    expect(rows.find((x) => x.id === 'cat-both')?.route_to).toBe('bar')
  })
})

describe('the rule itself, independent of any route', () => {
  it('only both requires acknowledgement', () => {
    expect(validateCategoryRouteWrite('kitchen', false).ok).toBe(true)
    expect(validateCategoryRouteWrite('bar', false).ok).toBe(true)
    expect(validateCategoryRouteWrite('both', false)).toEqual({
      ok: false,
      error: BOTH_ROUTE_REFUSAL,
    })
    expect(validateCategoryRouteWrite('both', true).ok).toBe(true)
  })

  it('states the consequence, not just the refusal — the merchant must learn WHY', () => {
    expect(BOTH_ROUTE_REFUSAL).toMatch(/kitchen AND the bar/i)
    expect(BOTH_ROUTE_REFUSAL).toMatch(/Ready/)
    expect(BOTH_ROUTE_REFUSAL).toMatch(/confirm_both/)
  })
})
