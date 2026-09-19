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
/**
 * F7. The tab's ORDERS, which are now where the served total comes from. Shaped the way
 * TAB_TOTAL_ORDER_COLUMNS selects them: no id, because this route is AGGREGATE_NO_IDS.
 */
let orderRows: Array<Record<string, unknown>>
/** Set to force the orders read to fail, for the fail-safe assertion. */
let orderReadError: { message: string } | null
/** Filters applied to the `orders` query, so the tab scoping can be asserted. */
let orderFilters: Filters
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
              if (table === 'orders') orderFilters.push(['eq', col, val])
              // The orders read is awaited directly off .eq(), so it resolves here.
              if (table === 'orders') {
                return Object.assign(
                  Promise.resolve(
                    orderReadError
                      ? { data: null, error: orderReadError }
                      : { data: orderRows, error: null },
                  ),
                  builder,
                )
              }
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
  orderFilters = []
  selects = {}
  orderReadError = null
  tableRow = { id: TABLE_ID }
  // Two orders totalling 184.50, so the derived figure and the (now irrelevant) stored column
  // agree by default. Every F7 test below makes them disagree on purpose.
  orderRows = [
    { total: 100.5, payment_status: 'pending', tab_settlement_for_tab_id: null },
    { total: 84, payment_status: 'paid', tab_settlement_for_tab_id: null },
  ]
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
    // F7: the served total no longer comes from the column at all, so it is a tab with NO ORDERS
    // that produces 0 here. `total: null` is left on the row above precisely to show it is not
    // what this assertion turns on any more.
    orderRows = []
    const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

    expect(body.tab).toEqual({
      id: TAB_ID,
      status: 'ready_to_pay',
      total: 0,
      pin_required: true,
      member_count: 0,
    })
  })

  /**
   * ================================================================================================
   * F7 — THE SERVED TOTAL IS DERIVED, AND `tabs.total` CANNOT MOVE IT
   * ================================================================================================
   *
   * THE OLD FAILURE MODE, reproduced below. `tabs.total` has five writers using two incompatible
   * definitions — thirteen production rows stored gross-ordered, six stored still-outstanding,
   * decided by whichever writer touched the row last — and seven money-changing events skip the
   * column entirely (order cancel, terminal order creation, refund, terminal payment failure,
   * request decline, table close, terminal status change).
   *
   * So a customer scanning the QR saw one of two different quantities, or a figure frozen before
   * the last three things that happened to their bill. These pin that the column can now hold
   * ANYTHING without the customer-facing figure moving.
   */
  describe('F7: the customer-facing total ignores the stale tabs.total column', () => {
    it('serves the DERIVED figure when the stored column disagrees', async () => {
      // The regression, in one line: the column says 999.99, the orders say 184.50.
      tabRows = [{ id: TAB_ID, status: 'open', total: 999.99, pin_required: true, members: MEMBERS }]
      const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

      expect(body.tab.total).toBe(184.5)
      expect(body.tab.total).not.toBe(999.99)
    })

    it('is UNCHANGED by any value the stored column takes', async () => {
      /**
       * The strong form. Before F7 each of these produced a different customer-facing figure while
       * the actual bill was identical — which is what "stale competing source of truth" means in
       * practice.
       */
      for (const stale of [0, null, 1, 184.49, 999999, -50]) {
        tabRows = [
          { id: TAB_ID, status: 'open', total: stale, pin_required: true, members: MEMBERS },
        ]
        const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
        expect(body.tab.total).toBe(184.5)
      }
    })

    it('follows the ORDERS when they change and the column does not', async () => {
      // The other direction: a money-changing event the column never hears about.
      tabRows = [{ id: TAB_ID, status: 'open', total: 184.5, pin_required: true, members: MEMBERS }]
      orderRows = [
        { total: 100.5, payment_status: 'pending', tab_settlement_for_tab_id: null },
        { total: 84, payment_status: 'paid', tab_settlement_for_tab_id: null },
        { total: 42, payment_status: 'pending', tab_settlement_for_tab_id: null },
      ]
      const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)

      expect(body.tab.total).toBe(226.5)
    })

    it('reads the orders scoped to THIS tab', async () => {
      await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
      expect(orderFilters).toEqual([['eq', 'tab_id', TAB_ID]])
    })

    it('selects NO id column — this is what keeps the route AGGREGATE_NO_IDS', async () => {
      /**
       * The security half. The route was NO_ORDER_READ in the guest-route manifest and is now
       * AGGREGATE_NO_IDS; the whole basis for that reclassification is that no order id can leave.
       * Asserted on the columns actually requested, not on the class label.
       */
      await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
      const columns = selects.orders.split(',').map((c) => c.trim())
      expect(columns.length).toBeGreaterThan(1)
      expect(columns.filter((c) => /(^|[^a-z_])id$/.test(c))).toEqual([])

      const wire = JSON.stringify(
        (await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)).body,
      )
      // The tab id is returned by contract; no ORDER id may be.
      expect(wire).not.toContain('order')
    })

    it('serves 0 rather than the stale column when the orders cannot be read', async () => {
      // Fails toward "unknown", never back to the number that is wrong by construction.
      tabRows = [{ id: TAB_ID, status: 'open', total: 999.99, pin_required: true, members: MEMBERS }]
      orderReadError = { message: 'orders unavailable' }
      const { status, body } = await call(
        `restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`,
      )

      expect(status).toBe(200)
      expect(body.tab.total).toBe(0)
      expect(body.tab.total).not.toBe(999.99)
    })

    it('still returns exactly the five contracted keys', async () => {
      // The route's own docblock says "do not widen it — the anon grant is being narrowed to
      // match". Deriving the figure must not become an excuse to add fields.
      const { body } = await call(`restaurantId=${RESTAURANT_UUID}&tableNumber=${TABLE_NUMBER}`)
      expect(Object.keys(body.tab).sort()).toEqual(
        ['id', 'member_count', 'pin_required', 'status', 'total'].sort(),
      )
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
