/**
 * The device callback must expect what the READER WAS ASKED FOR, not the order's original total.
 *
 * ================================================================================================
 * THE ORPHANED CHARGE THIS CLOSES
 * ================================================================================================
 *
 * Four gates decide whether a gateway amount is the one we asked for. Three of them ask the shared
 * authority, `expectedChargeForOrders`, over the settlement set:
 *
 *     app/api/terminal/orders/[orderId]/verify-payment/route.ts
 *     app/api/webhooks/paycloud/route.ts
 *     app/api/payments/reconcile/route.ts
 *
 * The fourth -- this one, the callback the terminal makes after WiseCashier reports success --
 * recomputed `Number(order.total)`. That is a DIFFERENT NUMBER whenever either is true:
 *
 *     the order is part-paid    prepare-payment charges `total - already settled`
 *     the charge carried a tip  prepare-payment adds the gratuity to the charge
 *
 * The card is already debited by the time this route runs. So the disagreement did not prevent a
 * charge -- it stranded one: money taken, order left `pending`, later swept as `auto_timeout` and
 * indistinguishable from a customer who never paid at all.
 *
 * ================================================================================================
 * THE INVARIANT
 * ================================================================================================
 *
 *     server_expected_charge = order.total - already_settled + tip_if_explicitly_added
 *
 * and the SAME figure must be used by preparation, the reader, this callback, settlement and
 * reconciliation. `pending_charge_cents` is where prepare-payment records it before the reader
 * launches; it is the only record that knows a gratuity was included.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

const RESTAURANT_ID = testUuid('cb01')
const ORDER_ID = testUuid('cb02')
const TERMINAL_ID = testUuid('cb03')

let db: InMemoryDb
const markPaidCalls: Array<{ amount: number }> = []
const mismatchCalls: Array<{ expectedAmount: number; receivedAmount: number | null }> = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => db.client(),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_ID,
    terminalId: TERMINAL_ID,
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: async (_db: unknown, args: { amount: number }) => {
    markPaidCalls.push({ amount: args.amount })
    return { claimed: true }
  },
}))

jest.mock('@/lib/payments/record-amount-mismatch', () => ({
  recordPaymentAmountMismatch: async (
    _db: unknown,
    args: { expectedAmount: number; receivedAmount: number | null },
  ) => {
    mismatchCalls.push({ expectedAmount: args.expectedAmount, receivedAmount: args.receivedAmount })
  },
}))

jest.mock('@/lib/payments/record-refused-second-payment', () => ({
  recordRefusedSecondPayment: async () => undefined,
}))

jest.mock('@/lib/payments/handle-terminal-payment-failed', () => ({
  handleTerminalPaymentFailed: async () => ({ cancelled: false }),
}))

jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))

 
const route = require('@/app/api/terminal/orders/[orderId]/payment/route') as {
  POST: (req: Request, ctx: { params: Promise<{ orderId: string }> }) => Promise<Response>
}

function callback(amount: number) {
  return new Request('http://localhost/api/terminal/orders/x/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'success',
      amount,
      reference: 'TXN-1',
      businessOrderNo: 'FT17887809045506221',
      paymentMethod: 'card',
    }),
  })
}

const ctx = { params: Promise.resolve({ orderId: ORDER_ID }) }

/**
 * `total` is what the order came to. `pending_charge_cents` is what prepare-payment actually asked
 * the reader for, which is the same thing ONLY when nothing has been settled and no tip was added.
 */
function seedOrder(fields: Record<string, unknown>) {
  db = new InMemoryDb({
    orders: [
      {
        id: ORDER_ID,
        restaurant_id: RESTAURANT_ID,
        tab_id: null,
        status: 'pending',
        payment_status: 'pending',
        paycloud_merchant_order_no: 'FT17887809045506221',
        payment_reference: null,
        pending_settlement_id: null,
        ...fields,
      },
    ],
  })
}

beforeEach(() => {
  markPaidCalls.length = 0
  mismatchCalls.length = 0
})

describe('a PART-PAID order — the real production shape (Digi Cofee #45)', () => {
  /**
   * N$37.00 ordered, N$17.00 already settled through two item allocations, N$20.00 genuinely owed.
   * prepare-payment writes pending_charge_cents = 2000 and the reader is asked for N$20.00.
   */
  const PART_PAID = {
    total: 37,
    pending_charge_cents: 2000,
    pending_tip_cents: 0,
  }

  test('ACCEPTS the outstanding amount the reader was actually asked for', async () => {
    seedOrder(PART_PAID)

    const res = await route.POST(callback(20), ctx)

    expect(res.status).toBe(200)
    expect(mismatchCalls).toHaveLength(0)
    // And the amount recorded as paid is the outstanding one, not the original total.
    expect(markPaidCalls).toEqual([{ amount: 20 }])
  })

  test('REFUSES the original total, which is more than was charged', async () => {
    seedOrder(PART_PAID)

    const res = await route.POST(callback(37), ctx)

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('AMOUNT_MISMATCH')
    expect(mismatchCalls[0]).toEqual({ expectedAmount: 20, receivedAmount: 37 })
    expect(markPaidCalls).toHaveLength(0)
  })
})

describe('a TIPPED charge', () => {
  test('ACCEPTS bill plus gratuity, which order.total alone can never equal', async () => {
    seedOrder({ total: 37, pending_charge_cents: 5700, pending_tip_cents: 2000 })

    const res = await route.POST(callback(57), ctx)

    expect(res.status).toBe(200)
    expect(mismatchCalls).toHaveLength(0)
    expect(markPaidCalls).toEqual([{ amount: 57 }])
  })

  test('REFUSES the bill without the gratuity', async () => {
    seedOrder({ total: 37, pending_charge_cents: 5700, pending_tip_cents: 2000 })

    const res = await route.POST(callback(37), ctx)

    expect(res.status).toBe(400)
    expect(mismatchCalls[0].expectedAmount).toBe(57)
  })
})

describe('the charge columns must actually be SELECTED, not merely present', () => {
  /**
   * ================================================================================================
   * WHY THIS BLOCK EXISTS -- THE HOLE THE TESTS ABOVE CANNOT SEE
   * ================================================================================================
   *
   * `InMemoryDb`'s `select()` ignores its column list and hands back the whole row. Every test above
   * therefore passes even if the route stops selecting `pending_charge_cents` -- and against real
   * PostgREST that column would simply be ABSENT, `expectedChargeForOrders` would fall back to the
   * order total on every row, and the entire defect would be back with no test going red.
   *
   * Measured: mutating the route's select to drop SETTLEMENT_SET_COLUMNS leaves all seven tests
   * above GREEN. That is a coverage claim that was false until this block was written.
   *
   * So this client PROJECTS, the way PostgREST does: a column that was not asked for does not come
   * back. It is local to this file -- changing the shared fake would alter what ~370 other suites
   * receive from every read.
   */
  function projectingDb(base: ReturnType<InMemoryDb['client']>) {
    return {
      ...base,
      from(table: string) {
        const builder = base.from(table)
        const originalSelect = builder.select.bind(builder)
        builder.select = (cols?: string) => {
          const chain = originalSelect(cols)
          if (table !== 'orders' || !cols) return chain
          const wanted = cols
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
          const pick = (row: Record<string, unknown> | null) => {
            if (!row) return row
            const out: Record<string, unknown> = {}
            for (const c of wanted) if (c in row) out[c] = row[c]
            return out
          }
          const originalSingle = chain.single.bind(chain)
          ;(chain as { single: () => Promise<{ data: unknown; error: unknown }> }).single =
            async () => {
              const r = await originalSingle()
              return { ...r, data: pick(r.data as Record<string, unknown> | null) }
            }
          return chain
        }
        return builder
      },
    }
  }

  test('a part-paid order is still charged correctly when the fake projects columns', async () => {
    seedOrder({ total: 37, pending_charge_cents: 2000, pending_tip_cents: 0 })
    const realClient = db.client.bind(db)
    db.client = (() => projectingDb(realClient())) as typeof db.client

    const res = await route.POST(callback(20), ctx)
    db.client = realClient

    // With a faithful projection this passes only because the route SELECTS the charge columns.
    expect(res.status).toBe(200)
    expect(markPaidCalls).toEqual([{ amount: 20 }])
  })
})

describe('the ordinary whole-order sale is unchanged', () => {
  /**
   * THE FIX MUST BE INERT HERE. This is the overwhelming majority of production -- 5,324 of 5,377
   * orders -- and a change that "fixes" the part-paid case by breaking this one is a far worse
   * defect than the one it closes.
   */
  test('a recorded attempt equal to the total is accepted', async () => {
    seedOrder({ total: 78, pending_charge_cents: 7800, pending_tip_cents: 0 })

    const res = await route.POST(callback(78), ctx)
    expect(res.status).toBe(200)
    expect(markPaidCalls).toEqual([{ amount: 78 }])
  })

  test('an order with NO recorded attempt still falls back to the order total', async () => {
    // Every order placed before pending_charge_cents existed, and every path that never prepares.
    seedOrder({ total: 78, pending_charge_cents: null, pending_tip_cents: null })

    const res = await route.POST(callback(78), ctx)
    expect(res.status).toBe(200)
    expect(markPaidCalls).toEqual([{ amount: 78 }])
  })

  test('and still refuses a figure that matches neither', async () => {
    seedOrder({ total: 78, pending_charge_cents: null, pending_tip_cents: null })

    const res = await route.POST(callback(12), ctx)
    expect(res.status).toBe(400)
    expect(mismatchCalls[0]).toEqual({ expectedAmount: 78, receivedAmount: 12 })
  })
})
