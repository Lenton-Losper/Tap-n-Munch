/**
 * A TAB WHOSE ORDERS WERE ALL CANCELLED MUST NEVER READ AS PAID.
 *
 * Observed on PRODUCTION 2026-08-28, Digi Cofee Table 1. The stale-payment sweep cancelled orders
 * #30, #31 and #32 (NAD 3 + 5 + 11). Cancelled orders correctly fall out of `unpaid_total`, so the
 * tab reported `unpaid_total: 0` — and the terminal, which maps zero-owed to fully-paid, rendered
 * PAID IN FULL over a table where nothing had ever been paid and the kitchen had already sent the
 * food out. `paid_at` was null on all three.
 *
 * A waiter reading "paid in full" closes the table. That is the expensive direction.
 *
 * THE FIX IS AT THE SOURCE, not in the client: `unpaid_total: 0` genuinely does not carry the
 * difference between "everything was paid" and "nothing was ever billed", so no client can be
 * expected to infer it. The route now reports the counts that make zero legible.
 *
 * THE CONTROL IS THE POINT. "A cancelled tab is not paid" passes trivially if the payload reports
 * nothing at all. Every assertion below is paired with a genuinely PAID tab that must report
 * differently — only the pair proves the payload discriminates rather than being uniformly blank.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE_ID = '9f1b2c3d-4e5a-4b6c-8d7e-0a1b2c3d4e5f'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'

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

jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        in: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            table === 'restaurant_tables'
              ? { data: tableRows, error: null }
              : { data: [], error: null },
          ),
      })
      return b
    },
  }),
}))

/** One order on the tab, with whatever payment_status the case needs. */
const order = (id: string, total: number, paymentStatus: string) => ({
  id,
  order_number: id,
  total,
  status: paymentStatus === 'cancelled' ? 'cancelled' : 'ready',
  payment_status: paymentStatus,
  terminal_pushed_at: null,
  items: [],
  placed_at: '2026-08-28T09:23:38.479Z',
})

function tabWith(orders: Record<string, unknown>[]) {
  return [
    {
      id: TABLE_ID,
      table_number: 1,
      status: 'occupied',
      tabs: [
        {
          id: TAB_ID,
          status: 'open',
          total: 0,
          payment_preference: 'single',
          orders,
        },
      ],
    },
  ]
}

async function callRoute() {
  const { GET } = await import('@/app/api/terminal/tables/route')
  const res = await GET(
    new NextRequest('https://staging.test/api/terminal/tables', {
      method: 'GET',
      headers: { authorization: 'Bearer test' },
    }),
  )
  const body = await res.json()
  return body.tables?.[0]?.tab ?? body[0]?.tab ?? null
}

describe('zero owed because cancelled is not zero owed because paid', () => {
  /** The exact production shape: three cancelled orders, nothing ever paid. */
  it('an all-cancelled tab reports zero owed AND zero paid', async () => {
    tableRows = tabWith([
      order('digi-30', 3, 'cancelled'),
      order('digi-31', 5, 'cancelled'),
      order('digi-32', 11, 'cancelled'),
    ])
    const tab = await callRoute()

    // The number that misled the terminal, unchanged and still correct on its own terms.
    expect(tab.unpaid_total).toBe(0)

    // The fields that make it legible. THIS is what distinguishes the two states.
    expect(tab.paid_order_count).toBe(0)
    expect(tab.billable_order_count).toBe(0)
    expect(tab.order_count).toBe(3)
  })

  /**
   * THE CONTROL. Same zero owed, but genuinely paid. If this reported the same numbers as the
   * case above, the payload would still be incapable of telling a waiter the truth.
   */
  it('CONTROL: a genuinely paid tab also owes zero, but reports paid orders', async () => {
    tableRows = tabWith([order('paid-1', 3, 'paid'), order('paid-2', 5, 'paid')])
    const tab = await callRoute()

    expect(tab.unpaid_total).toBe(0)
    expect(tab.paid_order_count).toBe(2)
    expect(tab.billable_order_count).toBe(2)
  })

  /**
   * The discrimination stated as the single assertion a client would branch on: both tabs owe
   * zero, and they are NOT the same state.
   */
  it('the two zero-owed tabs are distinguishable from each other', async () => {
    tableRows = tabWith([order('c', 3, 'cancelled')])
    const cancelled = await callRoute()
    tableRows = tabWith([order('p', 3, 'paid')])
    const paid = await callRoute()

    expect(cancelled.unpaid_total).toBe(paid.unpaid_total)
    expect(cancelled.paid_order_count).not.toBe(paid.paid_order_count)
  })

  it('a part-paid tab is neither: money still owed, and some already taken', async () => {
    tableRows = tabWith([order('paid-1', 3, 'paid'), order('owing', 5, 'pending')])
    const tab = await callRoute()

    expect(tab.unpaid_total).toBe(5)
    expect(tab.paid_order_count).toBe(1)
    expect(tab.unpaid_order_count).toBe(1)
  })

  /** A cancelled order alongside a real one must not inflate or deflate what is owed. */
  it('a cancelled order beside an unpaid one leaves the unpaid figure alone', async () => {
    tableRows = tabWith([order('dead', 11, 'cancelled'), order('live', 5, 'pending')])
    const tab = await callRoute()

    expect(tab.unpaid_total).toBe(5)
    expect(tab.paid_order_count).toBe(0)
    expect(tab.order_count).toBe(2)
    // Fewer billable than total orders is the signal that something on this tab was cancelled.
    expect(tab.billable_order_count).toBeLessThan(tab.order_count)
  })
})
