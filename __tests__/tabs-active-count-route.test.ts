/**
 * Issue #262 — GET /api/tabs/active is the redacting seam for the QR landing page.
 *
 * The landing page (app/menu/[restaurantId]/v2/page.tsx) used to run this lookup itself, as an
 * anon `select id, …, members, … from tabs`. The anon SELECT grant that permits it
 * (supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql) carries no
 * restaurant scope, so the same published key could list every member's `session_id` on every
 * open tab in every restaurant — and a session_id is a credential (fetchGuestOrdersBySession
 * looks a diner's orders up by it).
 *
 * The page only ever needed a COUNT. This route does the query as service_role and hands back
 * `member_count`. The tests below pin the two things that make that a safe swap:
 *
 *   1. `members` never leaves the route — only its length, under a different key.
 *   2. Every scoping filter the page applied is reproduced exactly, above all the 12-hour
 *      `created_at` cutoff. Dropping it would offer a walk-up yesterday's abandoned tab, which
 *      is the behaviour #211 settled.
 *
 * FAILS WITHOUT THE FIX: there is no route to import at all.
 */
import { GET } from '@/app/api/tabs/active/route'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const TABLE_ID = 'table-uuid-1'
const TABLE_NUMBER = 7

/** A member entry exactly as it sits in the column: session_id is the credential. */
const MEMBERS = [
  { session_id: 'sess-of-a-real-diner', joined_at: '2026-08-10T18:00:00.000Z', display_name: 'Ada' },
  { session_id: 'sess-of-another-diner', joined_at: '2026-08-10T18:05:00.000Z', display_name: 'Grace' },
]

type Filters = Array<[string, string, unknown]>

/** Filters applied to the `tabs` query, in order, so the scoping can be asserted. */
let tabFilters: Filters
/** Columns the route asked PostgREST for, per table. */
let selects: Record<string, string>
let tabRows: Array<Record<string, unknown>>
/** null models "no active restaurant_tables row for this number" — the table_number branch. */
let tableRow: { id: string } | null

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => {
    if (String(input) === 'unknown-restaurant') throw new Error('Restaurant not found')
    return RESTAURANT_UUID
  },
}))

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          selects[table] = columns
          const builder: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              if (table === 'tabs') tabFilters.push(['eq', col, val])
              return builder
            },
            in: (col: string, val: unknown) => {
              if (table === 'tabs') tabFilters.push(['in', col, val])
              return builder
            },
            gte: (col: string, val: unknown) => {
              if (table === 'tabs') tabFilters.push(['gte', col, val])
              return builder
            },
            limit: async () => ({ data: tabRows, error: null }),
            maybeSingle: async () => ({ data: tableRow, error: null }),
          }
          return builder
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  tabFilters = []
  selects = {}
  tableRow = { id: TABLE_ID }
  tabRows = [
    {
      id: TAB_ID,
      status: 'open',
      total: 184.5,
      pin_required: true,
      members: MEMBERS,
    },
  ]
})

async function call(query: string) {
  const res = await GET(new Request(`https://example.test/api/tabs/active?${query}`))
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

function filterFor(op: string, column: string) {
  return tabFilters.find(([o, c]) => o === op && c === column)
}

describe('GET /api/tabs/active — count, not members (#262)', () => {
  it('returns member_count and never the members array itself', async () => {
    const { status, body } = await call(
      `restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`
    )

    expect(status).toBe(200)
    expect(body.tab.member_count).toBe(2)

    // The harm is a session_id crossing the wire, so assert on the serialised body, not on keys.
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('session_id')
    expect(wire).not.toContain('sess-of-a-real-diner')
    expect(wire).not.toContain('display_name')
    expect(wire).not.toContain('joined_at')
  })

  it('returns exactly the five fields the landing page consumes and nothing else', async () => {
    const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

    expect(Object.keys(body)).toEqual(['tab'])
    expect(Object.keys(body.tab).sort()).toEqual(
      ['id', 'member_count', 'pin_required', 'status', 'total'].sort()
    )
    expect(body.tab).toMatchObject({
      id: TAB_ID,
      status: 'open',
      total: 184.5,
      pin_required: true,
    })
  })

  it('applies the landing page 12-hour created_at cutoff (#211 stale-tab behaviour)', async () => {
    const before = Date.now()
    await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
    const after = Date.now()

    const cutoff = filterFor('gte', 'created_at')
    expect(cutoff).toBeDefined()

    const cutoffMs = Date.parse(String(cutoff![2]))
    const twelveHours = 12 * 60 * 60 * 1000
    // Bounded by the wall clock either side of the call rather than a fixed constant, so the
    // assertion fails on 11h or 24h but not on scheduling jitter.
    expect(cutoffMs).toBeGreaterThanOrEqual(before - twelveHours - 5_000)
    expect(cutoffMs).toBeLessThanOrEqual(after - twelveHours + 5_000)
  })

  it('scopes to the restaurant and to active statuses only', async () => {
    await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

    expect(filterFor('eq', 'restaurant_id')).toEqual(['eq', 'restaurant_id', RESTAURANT_UUID])
    expect(filterFor('in', 'status')).toEqual(['in', 'status', ['open', 'ready_to_pay']])
  })

  it('filters by table_id when the table resolves, and by table_number when it does not', async () => {
    await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
    expect(filterFor('eq', 'table_id')).toEqual(['eq', 'table_id', TABLE_ID])
    expect(filterFor('eq', 'table_number')).toBeUndefined()

    tabFilters = []
    tableRow = null
    await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
    expect(filterFor('eq', 'table_number')).toEqual(['eq', 'table_number', TABLE_NUMBER])
    expect(filterFor('eq', 'table_id')).toBeUndefined()
  })

  it('reports no tab rather than an error when the table has none', async () => {
    tabRows = []
    const { status, body } = await call(
      `restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`
    )

    expect(status).toBe(200)
    expect(body).toEqual({ tab: null })
  })

  it('ignores a row whose status is not an active tab status', async () => {
    tabRows = [{ id: TAB_ID, status: 'settled', total: 0, pin_required: true, members: MEMBERS }]
    const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

    expect(body).toEqual({ tab: null })
  })

  it('carries the landing page normalisations: null members is 0, null pin_required is true', async () => {
    // `pin_required !== false` (not `Boolean(...)`) is deliberate and matches the landing
    // page: a null column must read as PIN-required, never as PIN-less.
    tabRows = [{ id: TAB_ID, status: 'ready_to_pay', total: null, pin_required: null, members: null }]
    const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

    expect(body.tab).toEqual({
      id: TAB_ID,
      status: 'ready_to_pay',
      total: 0,
      pin_required: true,
      member_count: 0,
    })
  })

  it('refuses a request with no table number — the count is per table, never per restaurant', async () => {
    const { status } = await call(`restaurantId=${RESTAURANT_UUID}`)
    expect(status).toBe(400)
    expect(tabFilters).toEqual([])
  })

  it('refuses a non-positive or non-numeric table number', async () => {
    expect((await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=0`)).status).toBe(400)
    expect((await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=-3`)).status).toBe(400)
    expect((await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=abc`)).status).toBe(400)
  })

  it('refuses a request with no restaurant id', async () => {
    const { status } = await call(`tableNumber=${TABLE_NUMBER}`)
    expect(status).toBe(400)
    expect(tabFilters).toEqual([])
  })

  it('404s an unknown restaurant instead of querying tabs unscoped', async () => {
    const { status } = await call(`restaurantId=unknown-restaurant&tableNumber=${TABLE_NUMBER}`)
    expect(status).toBe(404)
    expect(tabFilters).toEqual([])
  })
})
