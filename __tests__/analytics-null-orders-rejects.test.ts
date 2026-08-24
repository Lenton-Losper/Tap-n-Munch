/**
 * lib/supabase/analytics.ts destructured the orders query as `const { data: orders = [] }`.
 *
 * A destructuring default only fires for `undefined`. supabase-js returns `{ data: null, error }`
 * on ANY query failure (RLS denial, missing index, network), so `orders` is `null` on the exact
 * path the default was written to cover, and `orders.length` throws a bare TypeError.
 *
 * The fix must NOT be `orders ?? []`: that would report total_revenue 0 for a day whose revenue
 * query failed -- an ordinary-looking analytics row for money the query never saw. Reject, do not
 * default. These tests pin the rejection, and pin that no zeroed row is ever returned.
 *
 * Both exported readers are covered. Only `calculateDailyAnalytics` (server client) was flagged by
 * tsc; `getDailyAnalytics` uses the browser client whose `data` types as `any`, so the identical
 * defect was invisible to the compiler.
 */

const queryError = { message: 'index required on orders(placed_at)', code: '42P10' }

/** Terminal thenable standing in for a PostgREST builder that failed. */
function failingQuery() {
  const builder: Record<string, unknown> = {}
  // `range` added 2026-08-24 (#331). #323 moved both analytics readers onto fetchAllRows, which
  // calls .range() -- so this fake threw "query.range is not a function" before the assertion
  // ran, and the suite reported that instead of the error it exists to check. The property it
  // guards was never lost: fetchAllRows still throws, so an empty list can never stand in for a
  // failed query.
  for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'range']) {
    builder[method] = () => builder
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: queryError })
  return builder
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({ from: () => failingQuery() }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: { from: () => failingQuery() },
}))

import { calculateDailyAnalytics, getDailyAnalytics } from '@/lib/supabase/analytics'

describe('analytics rejects a null orders result instead of defaulting it', () => {
  it('calculateDailyAnalytics throws, naming the query failure', async () => {
    await expect(calculateDailyAnalytics('rest-1', '2026-08-10')).rejects.toThrow(
      /index required on orders/,
    )
  })

  it('getDailyAnalytics throws, naming the query failure', async () => {
    await expect(getDailyAnalytics('rest-1', '2026-08-10')).rejects.toThrow(
      /index required on orders/,
    )
  })

  it('never returns a zeroed revenue row for a failed query', async () => {
    for (const read of [calculateDailyAnalytics, getDailyAnalytics]) {
      let returned: unknown = 'did-not-return'
      try {
        returned = await read('rest-1', '2026-08-10')
      } catch {
        continue
      }
      throw new Error(
        `${read.name} returned instead of throwing: ${JSON.stringify(returned)}`,
      )
    }
  })
})
