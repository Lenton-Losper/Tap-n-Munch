/**
 * Issue #176 follow-up — the CLIENT-SIDE pre-flight query.
 *
 * This is the seam that broke on staging. Clicking Clear table produced:
 *
 *   Could not check open orders
 *   object is not iterable (cannot read property Symbol(Symbol.iterator))
 *
 * because the handler passed the WHOLE scope object to a filter.
 * `resolveOrderRestaurantScope` returns `{ restaurantId, firebaseRestaurantId }`, not an array,
 * and `.in()` iterates its argument at query-BUILD time — so it threw before any request was
 * sent, and no amount of database-level testing could have caught it.
 *
 * Nothing covered this: summariseClearImpact was unit-tested with arrays, and the end-to-end
 * test drove the route handler directly. The query between the button and the money check was
 * the only untested new code, and it was the piece that failed.
 *
 * The stub below reproduces PostgREST's real semantics — a filter value that is an object is a
 * bug, and iterating it is what throws — so the test fails the way production failed.
 */
import {
  fetchOpenOrdersForTable,
  summariseClearImpact,
  type ClearTableOrder,
} from '@/lib/tables/clear-table'
import type { OrderRestaurantScope } from '@/lib/supabase/restaurants'

const SCOPE: OrderRestaurantScope = {
  restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
  firebaseRestaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
}

type Filter = { column: string; value: unknown }

/**
 * Minimal PostgREST-shaped stub. Records every filter, and rejects a non-scalar filter value the
 * way the real client does — by trying to iterate it.
 */
function makeClient(rows: ClearTableOrder[], error: { message: string } | null = null) {
  const filters: Filter[] = []
  let selected = ''
  let table = ''

  const assertScalar = (column: string, value: unknown) => {
    if (value !== null && typeof value === 'object') {
      // Exactly what the real client does with an object where a scalar/array is expected.
      for (const _ of value as Iterable<unknown>) void _
    }
  }

  const builder = {
    eq(column: string, value: unknown) {
      assertScalar(column, value)
      filters.push({ column, value })
      return builder
    },
    then(resolve: (r: { data: ClearTableOrder[] | null; error: typeof error }) => unknown) {
      return Promise.resolve(resolve({ data: error ? null : rows, error }))
    },
  }

  const client = {
    from(name: string) {
      table = name
      return {
        select(columns: string) {
          selected = columns
          return builder
        },
      }
    },
  }

  return {
    client: client as never,
    inspect: () => ({ table, selected, filters }),
  }
}

describe('#176 pre-flight query (the seam that broke)', () => {
  test('filters by the restaurant ID STRING, never the scope object', async () => {
    const { client, inspect } = makeClient([])
    await fetchOpenOrdersForTable(client, SCOPE, 120)

    const { table, filters } = inspect()
    expect(table).toBe('orders')

    const restaurantFilter = filters.find((f) => f.column === 'restaurant_id')
    expect(typeof restaurantFilter?.value).toBe('string')
    expect(restaurantFilter?.value).toBe(SCOPE.restaurantId)
  })

  test('CONTROL: the stub really does reproduce the staging failure', async () => {
    // If this passes silently, the test above proves nothing — it would mean the stub tolerates
    // the exact bug that broke production.
    const { client } = makeClient([])
    const badClient = client as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (c: string, v: unknown) => unknown } }
    }
    expect(() => badClient.from('orders').select('*').eq('restaurant_id', SCOPE)).toThrow(
      /is not iterable/i,
    )
  })

  test('matches the route: restaurant, table number, is_closed=false, and no status filter', async () => {
    // The close route does NOT exclude completed/cancelled orders. Excluding them here would
    // make the confirmation disagree with what the server actually acts on.
    const { client, inspect } = makeClient([])
    await fetchOpenOrdersForTable(client, SCOPE, 9761)

    const cols = inspect().filters.map((f) => f.column)
    expect(cols).toContain('restaurant_id')
    expect(cols).toContain('table_number')
    expect(cols).toContain('is_closed')
    expect(cols).not.toContain('status')

    expect(inspect().filters.find((f) => f.column === 'table_number')?.value).toBe(9761)
    expect(inspect().filters.find((f) => f.column === 'is_closed')?.value).toBe(false)
  })

  test('returns rows the money check can actually consume', async () => {
    // The end-to-end contract: query -> summary, with no shape mismatch between them.
    const { client } = makeClient([
      { payment_status: 'paid', total: 50 },
      { payment_status: 'pending', total: 120 },
    ])
    const impact = summariseClearImpact(await fetchOpenOrdersForTable(client, SCOPE, 120))

    expect(impact.paid).toBe(1)
    expect(impact.unpaid).toBe(1)
    expect(impact.unpaidTotal).toBe(120)
    expect(impact.requiresConfirmation).toBe(true)
  })

  test('an empty table yields an empty array, not null', async () => {
    const { client } = makeClient([])
    await expect(fetchOpenOrdersForTable(client, SCOPE, 1)).resolves.toEqual([])
  })

  test('a query error THROWS rather than reporting "nothing is owed"', async () => {
    // The guard that behaved correctly on staging. Silence here would be a silent write-off.
    const { client } = makeClient([], { message: 'permission denied' })
    await expect(fetchOpenOrdersForTable(client, SCOPE, 120)).rejects.toThrow(/permission denied/)
  })
})
