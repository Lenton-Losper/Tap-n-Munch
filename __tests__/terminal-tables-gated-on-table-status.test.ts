/**
 * #177 — GET /api/terminal/tables is GATED on restaurant_tables.status.
 *
 * WHAT THIS SUITE IS. A coupling guard, not a correctness assertion. It pins the fact that the
 * payment terminal's table list is filtered on the stored `restaurant_tables.status` column, so
 * that fact cannot be removed silently. It deliberately does NOT claim the coupling is
 * desirable — #177 proposes dropping the column or making it derived, and if either is chosen
 * this suite SHOULD fail. Failing is the point: it is what forces whoever does that work to
 * confront the terminal rather than discover it in production.
 *
 * WHY IT EXISTS. #177 states, as the premise of its whole argument, that "nothing currently
 * reads it for a user-visible decision, which is exactly what makes it dangerous". That premise
 * is false on this branch. app/api/terminal/tables/route.ts:50 applies
 *
 *     .eq('status', 'occupied')
 *
 * to `.from('restaurant_tables')`, alongside `.in('tabs.status', ['open','ready_to_pay'])` on an
 * INNER join. So a table appears on the terminal only when BOTH hold. Two consequences the
 * issue's option analysis does not account for:
 *
 *   - dropping the column (#177 Option A) breaks this query outright — it both selects and
 *     filters on it;
 *   - a table whose status is anything other than 'occupied' while it has a live tab is
 *     INVISIBLE to the terminal, so staff cannot take payment on it. That is the dangerous
 *     direction, and it is the opposite of the stale-'occupied' drift the issue observed.
 *
 * WHAT IT ASSERTS AND WHAT IT CANNOT. The assertions read the filter chain the route hands to
 * PostgREST, not rows returned by a fake that re-implements filtering — a mock that applied the
 * filter itself would only prove the mock works. Asserting the outgoing query is the faithful
 * encoding of "this route constrains on that column", and it is exactly what breaks if the
 * constraint is deleted.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE_ID = '9f1b2c3d-4e5a-4b6c-8d7e-0a1b2c3d4e5f'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'

type Filter = { kind: 'eq' | 'in'; column: string; value: unknown }

/** Every filter the route applied, keyed by the table it was building a query against. */
let filtersByTable: Record<string, Filter[]>
let selectsByTable: Record<string, string[]>
let tableRows: Record<string, unknown>[]

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

// Returns the Map the route expects. Not under test; mocked so it cannot issue its own queries
// into the recorder below and muddy the filter chain being asserted.
jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const record = (f: Filter) => {
        ;(filtersByTable[table] ??= []).push(f)
      }
      Object.assign(b, {
        select: (cols?: string) => {
          ;(selectsByTable[table] ??= []).push(String(cols ?? ''))
          return b
        },
        eq: (column: string, value: unknown) => {
          record({ kind: 'eq', column, value })
          return b
        },
        in: (column: string, value: unknown) => {
          record({ kind: 'in', column, value })
          return b
        },
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === 'restaurant_tables' ? { data: tableRows, error: null } : { data: [], error: null }),
      })
      return b
    },
  }),
}))

beforeEach(() => {
  filtersByTable = {}
  selectsByTable = {}
  tableRows = [
    {
      id: TABLE_ID,
      table_number: 12,
      status: 'occupied',
      tabs: [
        {
          id: TAB_ID,
          status: 'open',
          total: 78.35,
          payment_preference: 'split',
          orders: [
            {
              id: ORDER_ID,
              order_number: 'A-1',
              total: 78.35,
              status: 'ready',
              payment_status: 'pending',
              terminal_pushed_at: null,
              items: [],
              placed_at: '2026-08-11T08:00:00.000Z',
            },
          ],
        },
      ],
    },
  ]
})

async function callRoute() {
  const { GET } = await import('@/app/api/terminal/tables/route')
  const res = await GET(
    new NextRequest('https://staging.test/api/terminal/tables', {
      method: 'GET',
      headers: { authorization: 'Bearer test' },
    }),
  )
  return { res, body: await res.json() }
}

describe('GET /api/terminal/tables — coupling to restaurant_tables.status', () => {
  it('constrains the restaurant_tables query on status = occupied', async () => {
    const { res } = await callRoute()
    expect(res.status).toBe(200)

    const applied = filtersByTable['restaurant_tables'] ?? []
    // The load-bearing assertion. If #177 Option A (drop the column) or Option B (make it
    // derived) is implemented, this is the line that goes red.
    expect(applied).toContainEqual({ kind: 'eq', column: 'status', value: 'occupied' })
  })

  it('also requires a live tab, so the status filter is an AND and not the only gate', async () => {
    await callRoute()
    const applied = filtersByTable['restaurant_tables'] ?? []

    expect(applied).toContainEqual({
      kind: 'in',
      column: 'tabs.status',
      value: ['open', 'ready_to_pay'],
    })
    // Both gates on the same query: a table needs status='occupied' AND a live tab. This is why
    // the stale-'occupied' drift #177 observed is largely masked on the terminal, while the
    // inverse — a live tab on a table not marked 'occupied' — is not masked at all.
    expect(applied).toContainEqual({ kind: 'eq', column: 'restaurant_id', value: RESTAURANT_UUID })
  })

  it('selects the column and echoes it to the terminal client', async () => {
    const { body } = await callRoute()

    expect((selectsByTable['restaurant_tables'] ?? []).join(' ')).toMatch(/\bstatus\b/)
    // The raw stored string is handed to the terminal app, whose source is not in this repo.
    // Any change to the column's vocabulary is therefore a client-visible change.
    expect(body.tables[0].status).toBe('occupied')
  })
})
