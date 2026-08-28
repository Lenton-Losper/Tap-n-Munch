/**
 * GET /api/admin/setup-status -- docs/design-venue-setup-flow.md. Covers the one piece of real
 * logic (category_routing.needs_attention) and that every count is scoped to the caller's
 * restaurant, not global.
 */
import { GET } from '@/app/api/admin/setup-status/route'

const RESTAURANT = 'rest-riviera'

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-1' }),
  getRestaurantIdForUser: async () => RESTAURANT,
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

let features: { station_screens_enabled: boolean } | null = null
let categories: Array<{ route_to: string | null }> = []
let terminals: Array<{ station_kind: string | null }> = []
let staffActiveCount = 0

jest.mock('@/lib/features/get-restaurant-features', () => ({
  getRestaurantFeatures: async () => features,
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      let isCountQuery = false
      const chain: Record<string, unknown> = {}
      chain.eq = () => chain
      chain.neq = () => chain
      chain.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (table === 'staff_members' && opts?.count === 'exact') isCountQuery = true
        return chain
      }
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (isCountQuery) return Promise.resolve(resolve({ data: null, error: null, count: staffActiveCount }))
        if (table === 'menu_categories') return Promise.resolve(resolve({ data: categories, error: null }))
        if (table === 'restaurant_terminals') return Promise.resolve(resolve({ data: terminals, error: null }))
        return Promise.resolve(resolve({ data: [], error: null }))
      }
      return chain
    },
  }),
}))

function call() {
  return GET(new Request('https://example.test/api/admin/setup-status'))
}

beforeEach(() => {
  features = { station_screens_enabled: true }
  categories = []
  terminals = []
  staffActiveCount = 0
})

describe('GET /api/admin/setup-status', () => {
  it('flags routing when categories exist but none route to the bar -- the Digi Cofee shape', async () => {
    categories = [{ route_to: 'kitchen' }, { route_to: 'kitchen' }, { route_to: null }]
    const res = await call()
    const body = await res.json()
    expect(body.category_routing.needs_attention).toBe(true)
    expect(body.category_routing.kitchen).toBe(3)
    expect(body.category_routing.bar).toBe(0)
  })

  it('does not flag routing once at least one category reaches the bar', async () => {
    categories = [{ route_to: 'kitchen' }, { route_to: 'bar' }]
    const res = await call()
    const body = await res.json()
    expect(body.category_routing.needs_attention).toBe(false)
  })

  it('does not flag routing with zero categories -- nothing to attend to yet', async () => {
    categories = []
    const res = await call()
    const body = await res.json()
    expect(body.category_routing.needs_attention).toBe(false)
    expect(body.category_routing.total).toBe(0)
  })

  it('a "both" category also clears the needs_attention flag', async () => {
    categories = [{ route_to: 'kitchen' }, { route_to: 'both' }]
    const res = await call()
    const body = await res.json()
    expect(body.category_routing.needs_attention).toBe(false)
  })

  it('counts paired terminals separately from total, excluding revoked', async () => {
    terminals = [{ station_kind: 'kitchen' }, { station_kind: null }, { station_kind: 'bar' }]
    const res = await call()
    const body = await res.json()
    expect(body.screen_pairing.paired).toBe(2)
    expect(body.screen_pairing.total).toBe(3)
  })

  it('reports the flag off plainly', async () => {
    features = { station_screens_enabled: false }
    const res = await call()
    const body = await res.json()
    expect(body.station_screens_enabled).toBe(false)
  })

  it('reports active staff count', async () => {
    staffActiveCount = 4
    const res = await call()
    const body = await res.json()
    expect(body.staff.active_count).toBe(4)
  })
})
