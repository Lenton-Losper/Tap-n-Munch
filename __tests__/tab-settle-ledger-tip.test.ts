/**
 * TAB SETTLE: EVERY SETTLEMENT HAS ITS LEDGER ROW, AND THE CARD ROW SAYS WHAT THE CARD WAS CHARGED.
 * (Sprint 2026-09-29 brief, F-MANUAL tasks 1 and 3.)
 *
 * TASK 1. A cash or PayToday tab settlement wrote the orders, a best-effort `payments` row and an
 * audit row, and NO ledger row (the F2 ruling kept cash out of payment_events). It now writes one
 * immutable `non_gateway_payment_events` row, REQUIRED: if it cannot be written the claim is put
 * back and the request fails, because a paid order with no ledger record is what the invariant
 * forbids.
 *
 * TASK 3. The card path's server-side sale row recorded `expectedAmount` -- the bill without the
 * gratuity -- while settle_order_payment() records the CHARGE, tip included, for the same kind of
 * row. A tipped tab settle therefore wrote a sale row short by the tip; the device's own
 * recordSaleEvent (the charged amount) then collided with it and got a 409, and the refundable
 * balance was short by the tip. The row now carries bill + tip, and the tip stays derivable from
 * payment_tips under the same payment_reference -- the same model the RPC path uses.
 *
 * The invoice must still EXCLUDE the gratuity (owner's ruling 2026-09-05): its paid figure comes
 * from the orders' settled charges, never from the sale row's amount.
 *
 * Runs the REAL route against the in-memory PostgREST store.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'
import { invoicePaymentRecords, planInvoice } from '@/lib/documents/invoice-projection'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000031'
const TIP_STAFF = '66666666-6666-4666-8666-666666666666'

let mockDb: InMemoryDb
/** When set, the non-gateway ledger insert fails. */
let mockLedgerFails = false
/** When set, the database refuses the paid claim with FTCHG (20260929120000). */
let mockFtchg = false
const IN_FLIGHT_WINDOW_MS = 5 * 60 * 1000

/**
 * A MODEL of release_stale_card_attempts (20260929100100) -- the function itself, with its lock,
 * its intents and its audit row, is proven against Postgres by manual-ledger.test.sql and
 * manual-ledger-race.test.sh. This proves the route's side: it asks, obeys, and fails closed.
 */
function mockReleaseStaleCardAttempts(a: Record<string, unknown>) {
  const ids = (a.p_order_ids as string[]).map(String)
  const rows = mockDb.rows('orders').filter((o) => ids.includes(String(o.id)) && o.pending_charge_cents != null)
  const inFlight = rows.filter(
    (o) => o.pending_charge_at == null || Date.now() - Date.parse(String(o.pending_charge_at)) < IN_FLIGHT_WINDOW_MS,
  )
  if (inFlight.length > 0) {
    return { data: { ok: false, reason: 'payment_in_flight', in_flight_order_ids: inFlight.map((o) => o.id) }, error: null }
  }
  for (const o of rows) Object.assign(o, { pending_charge_cents: null, pending_tip_cents: 0, pending_charge_at: null })
  return { data: { ok: true, released_order_ids: rows.map((o) => o.id) }, error: null }
}

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))
jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      async rpc(name: string, args: Record<string, unknown>) {
        mockDb.rpcCalls.push({ name, args })
        if (name === 'release_stale_card_attempts') return mockReleaseStaleCardAttempts(args)
        return client.rpc(name, args)
      },
      from(table: string) {
        const b = client.from(table) as unknown as Record<string, unknown> & {
          in: (c: string, v: unknown[]) => unknown
        }
        // The cash claim's `.or()`: every fixture order is `pending`, so the in-list half decides.
        b.or = (expr: string) => {
          const m = /^payment_status\.in\.\(([^)]*)\),/.exec(expr)
          if (!m) throw new Error(`unmodelled .or(${expr})`)
          return b.in('payment_status', m[1].split(','))
        }
        if (table === 'orders' && mockFtchg) {
          const update = (b.update as (p: Record<string, unknown>) => unknown).bind(b)
          b.update = (payload: Record<string, unknown>) => {
            if (payload.payment_status !== 'paid') return update(payload)
            // The trigger aborts the whole claim statement: nothing is written.
            const refused: Record<string, unknown> = {}
            for (const m of ['in', 'eq', 'or', 'select']) refused[m] = () => refused
            refused.then = (ok: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { code: 'FTCHG', message: 'order changed after its card charge was prepared' } }).then(ok)
            return refused
          }
        }
        if (table === 'non_gateway_payment_events' && mockLedgerFails) {
          b.insert = () => ({
            select: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'ledger insert refused (test)' } }),
            }),
          })
        }
        return b
      },
    }
  },
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb(
    {
      tabs: [{ id: TAB, restaurant_id: RESTAURANT, table_id: 'table-1', total: 720, status: 'open', settled_at: null }],
      orders: f.orders.map((o) => ({
        ...o,
        restaurant_id: RESTAURANT,
        terminal_pushed_at: null,
        payment_method: null,
        payment_reference: null,
        payment_voucher_no: null,
        paycloud_merchant_order_no: null,
        paid_at: null,
        completed_at: null,
      })),
      order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
      order_line_allocations: [],
      order_line_allocation_settlements: [],
      order_requests: [],
      restaurant_users: [{ restaurant_id: RESTAURANT, user_id: TIP_STAFF, deleted_at: null }],
      payments: [],
      payment_events: [],
      payment_tips: [],
      non_gateway_payment_events: [],
      audit_logs: [],
    },
    {
      // The real keys: one sale row per gateway reference, one ledger row per collection.
      payment_events: { unique: [['restaurant_id', 'idempotency_key']] },
      non_gateway_payment_events: { unique: [['restaurant_id', 'idempotency_key']] },
      payment_tips: { unique: [['restaurant_id', 'payment_reference']] },
    },
  )
}

async function settle(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/tabs/${TAB}/settle`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!
const ledger = () => mockDb.rows('non_gateway_payment_events')
const sales = () => mockDb.rows('payment_events').filter((e) => e.event_type === 'sale')

/** N$220 + N$500 on one tab: the Riviera pair. */
function twoOrders() {
  const f = new AmendFixture(TAB)
  const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
  const b = f.place([{ name: 'Steak', quantity: 1, total: 500 }])
  seed(f)
  return { a: a.id, b: b.id }
}

const card = (orderIds: string[], amount: number, extra: Record<string, unknown> = {}) =>
  settle({ order_ids: orderIds, amount, method: 'card', business_order_no: 'FT-BON-9', voucher_no: 'V-9', ...extra })

beforeEach(() => {
  mockLedgerFails = false
  mockFtchg = false
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('task 1: a non-gateway tab settlement writes exactly one immutable ledger row', () => {
  it('cash, no tip: one row with the server bill, cash, both orders, the terminal as actor -- and no gateway row', async () => {
    const { a, b } = twoOrders()
    const { status, body } = await settle({ order_ids: [a, b], amount: 720, method: 'cash' })
    expect(status).toBe(200)
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({
      restaurant_id: RESTAURANT,
      origin: 'terminal_tab_settle',
      method: 'cash',
      amount_cents: 72000,
      tip_cents: 0,
      order_ids: [a, b],
      tab_id: TAB,
      payment_reference: order(a).payment_reference,
      recorded_by: null,
      actor_attribution: 'terminal_only',
      terminal_id: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    })
    expect(body.ledger_event_id).toBe(ledger()[0].id)
    expect(sales()).toHaveLength(0)
  })

  it('the figure is the SERVER bill even when the device sends the legacy basis', async () => {
    const f = new AmendFixture(TAB)
    const o = f.place([
      { name: 'Burger', quantity: 1, total: 220 },
      { name: 'Starter', quantity: 1, total: 60 },
    ])
    f.amend(o.id, 'Starter', 0)
    seed(f)
    // 280 is orders.total (the pre-outstanding basis an old APK sends); 220 is what is owed.
    const { status } = await settle({ order_ids: [o.id], amount: 280, method: 'cash' })
    expect(status).toBe(200)
    expect(ledger()[0].amount_cents).toBe(22000)
  })

  it('cash + tip: amount is what the drawer took (bill + tip), tip_cents says which part', async () => {
    const { a, b } = twoOrders()
    const { status } = await settle({
      order_ids: [a, b], amount: 720, method: 'cash', tip_cents: 5000, tip_staff_user_id: TIP_STAFF,
    })
    expect(status).toBe(200)
    expect(ledger()[0]).toMatchObject({ amount_cents: 77000, tip_cents: 5000 })
    expect(mockDb.rows('payment_tips')).toHaveLength(1)
    expect(mockDb.rows('payment_tips')[0].tip_cents).toBe(5000)
  })

  it('PayToday: one row, method paytoday', async () => {
    const { a } = twoOrders()
    const { status } = await settle({ order_ids: [a], amount: 220, method: 'paytoday' })
    expect(status).toBe(200)
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({ method: 'paytoday', amount_cents: 22000, order_ids: [a] })
  })

  it('a replay of the same settlement is ALREADY_PAID and writes no second row', async () => {
    const { a, b } = twoOrders()
    await settle({ order_ids: [a, b], amount: 720, method: 'cash' })
    const again = await settle({ order_ids: [a, b], amount: 720, method: 'cash' })
    expect(again.status).toBe(409)
    expect(ledger()).toHaveLength(1)
  })

  it('NO LEDGER, NO SETTLEMENT: a failed ledger write puts the orders back and fails the request', async () => {
    const { a, b } = twoOrders()
    mockLedgerFails = true
    const { status, body } = await settle({ order_ids: [a, b], amount: 720, method: 'cash' })
    expect(status).toBe(503)
    expect(body.code).toBe('PAYMENT_LEDGER_NOT_RECORDED')
    expect(body.unreverted_order_ids).toEqual([])
    for (const id of [a, b]) {
      expect(order(id).payment_status).toBe('pending')
      expect(order(id).payment_reference).toBeNull()
    }
    expect(mockDb.rows('payments')).toHaveLength(0)
    expect(mockDb.rows('audit_logs').map((r) => r.action)).toEqual(['payment.settle_ledger_not_recorded'])
  })

  it('a CARD settlement goes to the gateway ledger, never to this one', async () => {
    const { a, b } = twoOrders()
    const { status } = await card([a, b], 720)
    expect(status).toBe(200)
    expect(ledger()).toHaveLength(0)
    expect(sales()).toHaveLength(1)
  })
})

describe('task 3: the card sale row records what the card was charged, tip included', () => {
  it('no tip: the sale row is the bill', async () => {
    const { a, b } = twoOrders()
    await card([a, b], 720)
    expect(Number(sales()[0].amount)).toBe(720)
  })

  it('multi-order tab + tip: the sale row is bill + tip; the bill is derivable through payment_tips', async () => {
    const { a, b } = twoOrders()
    const { status, body } = await card([a, b], 720, { tip_cents: 7200, tip_staff_user_id: TIP_STAFF })
    expect(status).toBe(200)
    expect(body.sale_event).toBe('recorded')
    const sale = sales()[0]
    expect(Number(sale.amount)).toBe(792)
    expect(sale.order_ids).toEqual([a, b])

    // Consistency: sale − tip (by this payment's reference) = Σ settled charges = payments.amount.
    const reference = String(order(a).payment_reference)
    const tip = mockDb.rows('payment_tips').find((t) => t.payment_reference === reference)!
    expect(tip.tip_cents).toBe(7200)
    const settled = Number(order(a).settled_charge_cents) + Number(order(b).settled_charge_cents)
    expect(Math.round(Number(sale.amount) * 100) - Number(tip.tip_cents)).toBe(settled)
    expect(settled).toBe(72000)
    expect(Number(mockDb.rows('payments')[0].amount)).toBe(720)
  })

  it('partial payment + tip: one order of two, the row covers that order and its bill + tip only', async () => {
    const { a, b } = twoOrders()
    const { status } = await card([b], 500, { tip_cents: 2500, tip_staff_user_id: TIP_STAFF })
    expect(status).toBe(200)
    expect(sales()).toHaveLength(1)
    expect(Number(sales()[0].amount)).toBe(525)
    expect(sales()[0].order_ids).toEqual([b])
    expect(order(a).payment_status).toBe('pending')
    expect(order(b).settled_charge_cents).toBe(50000)
  })

  it('invoice + tip: the invoice is the bill -- the gratuity is outside it (2026-09-05 ruling)', async () => {
    const { a, b } = twoOrders()
    await card([a, b], 720, { tip_cents: 7200, tip_staff_user_id: TIP_STAFF })
    // The food has gone out: every line collected, so the invoice is final.
    for (const l of mockDb.rows('order_lines')) {
      if (l.kitchen_state != null) l.kitchen_state = 'collected'
      if (l.bar_state != null) l.bar_state = 'collected'
    }
    const plan = planInvoice({
      scope: 'tab',
      orders: mockDb.rows('orders') as never,
      lines: mockDb.rows('order_lines') as never,
      settledByOrder: new Map(),
      refundedOrderIds: new Set(),
    })
    if (!plan.ok) throw new Error(`invoice refused: ${plan.code} ${plan.message}`)
    expect(plan.liveCents).toBe(72000)
    expect(plan.paidCents).toBe(72000)
    expect(plan.outstandingCents).toBe(0)
    const records = invoicePaymentRecords({
      perOrder: plan.perOrder,
      orders: mockDb.rows('orders') as never,
      settledByOrder: new Map(),
      allocationSettlements: [],
      saleEvents: sales() as never,
    })
    expect(records).not.toBeNull()
    expect(records!.reduce((s, r) => s + r.amountCents, 0)).toBe(72000)
  })
})

/**
 * TEAM-LEAD RULING (Sprint 2026-09-29): a non-gateway settlement is a FRESH charge at the live
 * amount -- it neither races a card attempt that may be running nor settles over a dead one -- and a
 * genuine card settlement the database refuses as changed (FTCHG) is held, never a 500.
 */
describe('card attempts and the FTCHG refusal', () => {
  const prepare = (id: string, ageMs: number) =>
    Object.assign(order(id), {
      pending_charge_cents: 22000,
      pending_charge_at: new Date(Date.now() - ageMs).toISOString(),
    })

  it('cash over a card charge prepared INSIDE the window: 409 PAYMENT_IN_FLIGHT, nothing written', async () => {
    const { a } = twoOrders()
    prepare(a, 30_000)
    const { status, body } = await settle({ order_ids: [a], amount: 220, method: 'cash' })
    expect(status).toBe(409)
    expect(body.code).toBe('PAYMENT_IN_FLIGHT')
    expect(order(a).payment_status).toBe('pending')
    expect(order(a).pending_charge_cents).toBe(22000)
    expect(ledger()).toHaveLength(0)
  })

  it('cash over a DEAD attempt (older than the window): released first, then settled once', async () => {
    const { a } = twoOrders()
    prepare(a, 10 * 60_000)
    const { status } = await settle({ order_ids: [a], amount: 220, method: 'cash' })
    expect(status).toBe(200)
    expect(mockDb.rpcCalls.filter((c) => c.name === 'release_stale_card_attempts')).toHaveLength(1)
    expect(order(a).pending_charge_cents).toBeNull()
    expect(order(a).payment_status).toBe('paid')
    expect(ledger()).toHaveLength(1)
  })

  it('no card history: the release is not even asked (settlement exactly as before)', async () => {
    const { a } = twoOrders()
    await settle({ order_ids: [a], amount: 220, method: 'cash' })
    expect(mockDb.rpcCalls.filter((c) => c.name === 'release_stale_card_attempts')).toHaveLength(0)
  })

  it('a CARD settlement refused FTCHG: every charged order HELD, 409 ORDER_CHANGED_DURING_PAYMENT, card_charged', async () => {
    const { a, b } = twoOrders()
    mockFtchg = true
    const { status, body } = await card([a, b], 720)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_CHANGED_DURING_PAYMENT')
    expect(body.card_charged).toBe(true)
    expect(order(a).payment_status).toBe('amount_mismatch_hold')
    expect(order(b).payment_status).toBe('amount_mismatch_hold')
    expect(sales()).toHaveLength(0)
    const held = mockDb.rows('audit_logs').filter((r) => r.action === 'payment.held_order_changed_since_charge_prepared')
    expect(held).toHaveLength(1)
    expect(held[0].metadata).toMatchObject({ card_charged: true, held_order_ids: [a, b] })
  })
})
