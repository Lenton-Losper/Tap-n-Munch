/**
 * #191 — the tab settle route must STORE the monetary total, not a binary artefact of how it
 * was summed.
 *
 * This is deliberately not a test of the amount comparison. That comparison is already correct:
 * since #180 `amountsMatch` rounds both operands to whole cents, and
 * __tests__/amounts-match-cent-tolerance.test.ts:130 pins the exact sum used here —
 * `amountsMatch(105.3, 35.10 + 27.25 + 42.95, 0)` is true at ZERO tolerance. A suite that only
 * drove the route and checked the status code would have passed against the defect, which is
 * why every assertion below reads a WRITTEN payload instead.
 *
 * The route sums order totals in floating point and writes the result to three places:
 *
 *   payments.amount              settle/route.ts:380
 *   audit_logs.metadata.amount   settle/route.ts:398
 *   tabs.total                   settle/route.ts:368, from the recalculation at :363-365
 *
 * All three columns are `numeric` with no scale, so Postgres stores the expansion verbatim
 * rather than rounding it away, and `tabs.total` is served onward to the guest app and the
 * terminal APK. A stored 105.30000000000001 makes an identical payment look like a
 * disagreement to any other consumer, and the refund ceiling — `(prior + requested) > amount` —
 * can resolve differently for a sale row sitting a fraction of a cent either side of the true
 * total.
 *
 * The fixture totals are the ones from the issue: 35.10 + 27.25 + 42.95 sums to
 * 105.30000000000001, not 105.30. `guardFixtureIsInexact` below asserts that, so this suite
 * fails loudly if a future change to the fixtures picks amounts that happen to sum exactly —
 * which would leave every assertion here passing while proving nothing.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'

/** Order totals that do not sum to their own 2dp value in binary floating point. */
const TOTALS = [35.1, 27.25, 42.95]
const FLOAT_SUM = TOTALS.reduce((sum, t) => sum + t, 0) // 105.30000000000001
const EXACT = 105.3

const SETTLED_IDS = [
  '133ffc3a-106b-4076-bf23-2dd55cba8d9c',
  '2a6c19b4-8f0d-4c3e-9b71-5d8e2f4a6c10',
  '3b7d2ac5-9e1f-4d40-8c62-6e9f3a5b7d21',
]
const REMAINING_IDS = [
  '4c8e3bd6-af20-4e51-9d73-7fa04b6c8e32',
  '5d9f4ce7-b031-4f62-ae84-80b15c7d9f43',
  '6ea05df8-c142-4073-bf95-91c26d8ea054',
]

type Row = Record<string, unknown>
type Write = { table: string; op: 'insert' | 'update'; payload: Record<string, unknown> }

let writes: Write[]
let tabRow: Row
let settledOrders: Row[]
let remainingUnpaidOrders: Row[]

// ---------------------------------------------------------------- module mocks

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))

// Not under test, and it writes to `tabs` — mocked so its updates cannot be mistaken for the
// tab-total recalculation this suite asserts on.
jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))

/**
 * Table-aware PostgREST stand-in, same shape as the one in
 * __tests__/terminal-payment-cent-tolerance-routes.test.ts, with every insert and update
 * payload recorded so the STORED figures can be asserted rather than inferred.
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state = { table, op: 'select', filters: [] as string[] }
      const b: Record<string, unknown> = {}
      const resolveList = () => {
        if (state.table !== 'orders') return { data: null, error: null }
        // The atomic claim, read back via .select('id').
        if (state.op === 'update') {
          return { data: settledOrders.map((o) => ({ id: o.id })), error: null }
        }
        // The selection being settled, bound by .in('id', order_ids).
        if (state.filters.includes('in:id')) return { data: settledOrders, error: null }
        // Anything else is a "what is still owed" question: the tab-total recalculation and
        // the can_close check. Both see the orders left unpaid on this tab.
        return { data: remainingUnpaidOrders, error: null }
      }
      Object.assign(b, {
        select: () => b,
        update: (payload: Record<string, unknown>) => {
          state.op = 'update'
          writes.push({ table: state.table, op: 'update', payload })
          return b
        },
        insert: async (payload: Record<string, unknown>) => {
          writes.push({ table: state.table, op: 'insert', payload })
          return { data: null, error: null }
        },
        eq: () => b,
        neq: () => b,
        in: (col: string) => {
          state.filters.push(`in:${col}`)
          return b
        },
        is: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        single: async () => ({ data: state.table === 'tabs' ? tabRow : null, error: null }),
        maybeSingle: async () => ({ data: state.table === 'tabs' ? tabRow : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(resolveList()),
      })
      return b
    },
  }),
}))

// ---------------------------------------------------------------- fixtures

beforeEach(() => {
  writes = []
  tabRow = {
    id: TAB_ID,
    table_id: 'table-uuid-1',
    total: 210.6,
    status: 'open',
    settled_at: null,
  }
  settledOrders = SETTLED_IDS.map((id, i) => ({
    id,
    total: TOTALS[i],
    payment_status: 'pending',
    terminal_pushed_at: null,
  }))
  // Still owed after this settlement. Same three totals, so the recalculated tab total runs
  // into the identical float expansion as the settled sum.
  remainingUnpaidOrders = REMAINING_IDS.map((id, i) => ({
    id,
    total: TOTALS[i],
    payment_status: 'pending',
  }))
})

/** The fixtures only exercise the defect while their sum is genuinely inexact. */
function guardFixtureIsInexact() {
  expect(FLOAT_SUM).not.toBe(EXACT)
  expect(String(FLOAT_SUM)).toBe('105.30000000000001')
}

async function settle() {
  const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const res = await POST(
    new NextRequest('https://staging.test/api/terminal/tabs/x/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        order_ids: SETTLED_IDS,
        amount: EXACT,
        method: 'card',
        gateway_reference: 'GW-1',
      }),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) },
  )
  return { res, body: await res.json() }
}

const writeOf = (table: string, op: 'insert' | 'update') =>
  writes.find((w) => w.table === table && w.op === op)

// ---------------------------------------------------------------- the three write sites

describe('POST /api/terminal/tabs/[tabId]/settle — stored amounts are whole cents', () => {
  it('settles the tab (the comparison was never the defect)', async () => {
    guardFixtureIsInexact()
    const { res, body } = await settle()

    // Stated as a control: the route already accepted this settlement before the fix, because
    // amountsMatch compares in integer cents. Everything below is about what it then WROTE.
    expect({ status: res.status, success: body.success }).toEqual({ status: 200, success: true })
  })

  it('writes payments.amount as 105.30, not the float expansion', async () => {
    guardFixtureIsInexact()
    await settle()

    const payment = writeOf('payments', 'insert')
    expect(payment).toBeDefined()
    expect(payment!.payload.amount).toBe(EXACT)
    // `numeric` with no scale stores what it is given verbatim, so the serialized form is
    // what a downstream consumer actually reads back.
    expect(String(payment!.payload.amount)).toBe('105.3')
  })

  it('writes audit_logs.metadata.amount as 105.30, not the float expansion', async () => {
    guardFixtureIsInexact()
    await settle()

    const audit = writeOf('audit_logs', 'insert')
    expect(audit).toBeDefined()
    const metadata = audit!.payload.metadata as Record<string, unknown>
    expect(metadata.amount).toBe(EXACT)
    expect(String(metadata.amount)).toBe('105.3')
  })

  it('writes the recalculated tabs.total as 105.30, not the float expansion', async () => {
    guardFixtureIsInexact()
    const { body } = await settle()

    // The only customer-visible one of the three: this figure is served to the guest app and
    // to the terminal APK as the outstanding balance.
    const tabUpdate = writeOf('tabs', 'update')
    expect(tabUpdate).toBeDefined()
    expect(tabUpdate!.payload.total).toBe(EXACT)
    expect(String(tabUpdate!.payload.total)).toBe('105.3')

    // And the same figure is handed straight back to the caller.
    expect(body.new_tab_total).toBe(EXACT)
  })

  it('reports the rounded expected total in an AMOUNT_MISMATCH refusal', async () => {
    guardFixtureIsInexact()
    const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
    const res = await POST(
      new NextRequest('https://staging.test/api/terminal/tabs/x/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
        body: JSON.stringify({
          order_ids: SETTLED_IDS,
          // Two cents out: a genuine disagreement, still refused.
          amount: 105.32,
          method: 'card',
          gateway_reference: 'GW-1',
        }),
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const body = await res.json()

    expect({ status: res.status, code: body.code }).toEqual({
      status: 400,
      code: 'AMOUNT_MISMATCH',
    })
    // The figure the terminal shows staff when it refuses. 105.30000000000001 is not a number
    // anyone can reconcile against a printed bill.
    expect(body.expected).toBe(EXACT)
    expect(writes).toHaveLength(0)
  })
})
