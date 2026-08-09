/**
 * #156 at the route boundary: POST /api/terminal/tabs/{tabId}/settle.
 *
 * This is the test that reproduces the defect. Against the route as it was -- payment_status
 * set server-side, no ledger entry written at all -- "a card settle produces exactly one SALE
 * row" fails with 0 rows. The fake enforces the real payment_events constraints, so it cannot
 * pass by accepting anything.
 *
 * The cash assertions are the regression guard. Cash is the path a merchant uses daily and the
 * one verified on hardware; it must produce no SALE row and must be otherwise untouched.
 */
import { FakeDb } from './helpers/fake-payment-events-db'
import {
  SALE_LEDGER_WRITE_FAILED_ACTION,
  SETTLE_CARD_REASON_CODE,
} from '@/lib/payments/record-settlement-sale-event'

const RESTAURANT = 'rest-1'
const TERMINAL = 'term-1'
const TAB = 'tab-1'

let db: FakeDb

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => db.client(),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'rest-1',
    terminalId: 'term-1',
    deviceSerial: 'SN-1',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => {},
}))

jest.mock('@/lib/payment-reference', () => ({
  generatePaymentReference: () => 'PAYREF-TEST',
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => {},
}))

jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => {},
}))

jest.mock('@/lib/terminal-auth/consume-authorization-token', () => ({
  consumeAuthorizationToken: async () => ({ ok: true }),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('@/app/api/terminal/tabs/[tabId]/settle/route')

function seed(options: { orders: Array<{ id: string; total: number; status?: string }> }) {
  db = new FakeDb()
  db.tables.tabs.push({
    id: TAB,
    restaurant_id: RESTAURANT,
    table_id: 'table-1',
    total: options.orders.reduce((s, o) => s + o.total, 0),
    status: 'open',
    settled_at: null,
  })
  for (const o of options.orders) {
    db.tables.orders.push({
      id: o.id,
      tab_id: TAB,
      restaurant_id: RESTAURANT,
      total: o.total,
      payment_status: o.status ?? 'pending',
      terminal_pushed_at: null,
      paycloud_merchant_order_no: null,
    })
  }
}

function settle(body: Record<string, unknown>) {
  return POST(
    new Request('https://example.test/api/terminal/tabs/tab-1/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
}

const CARD_BODY = {
  order_ids: ['o1'],
  amount: 35,
  method: 'card',
  business_order_no: 'FT1785738099890',
  voucher_no: 'FT1785738099890',
}

describe('a CARD settle writes exactly one SALE row', () => {
  beforeEach(() => seed({ orders: [{ id: 'o1', total: 35 }] }))

  it('settles successfully', async () => {
    const res = await settle(CARD_BODY)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true, method: 'card' })
  })

  it('produces EXACTLY ONE sale row — 0 before this change', async () => {
    await settle(CARD_BODY)
    expect(db.saleRows()).toHaveLength(1)
  })

  it('links the row to the claimed order and carries the settle reason_code', async () => {
    await settle(CARD_BODY)
    const row = db.saleRows()[0]
    expect(row.order_ids).toEqual(['o1'])
    expect(row.event_type).toBe('sale')
    expect(row.reason_code).toBe(SETTLE_CARD_REASON_CODE)
    expect(row.restaurant_id).toBe(RESTAURANT)
    expect(row.terminal_id).toBe(TERMINAL)
  })

  it('records the SERVER total, not the client-supplied amount', async () => {
    // The client amount is validated against the server total before the claim, so the two
    // agree here -- but the ledger must read from the server side regardless, the same rule
    // the payments insert already follows.
    await settle(CARD_BODY)
    expect(db.saleRows()[0].amount).toBe(35)
  })

  it('covers every order of a multi-order tab settle with one row', async () => {
    seed({ orders: [{ id: 'o1', total: 20 }, { id: 'o2', total: 15 }] })
    await settle({ ...CARD_BODY, order_ids: ['o1', 'o2'], amount: 35 })

    expect(db.saleRows()).toHaveLength(1)
    expect(db.saleRows()[0].order_ids).toEqual(['o1', 'o2'])
    expect(db.saleRows()[0].amount).toBe(35)
  })

  it('reports the ledger outcome in the response and the settle audit row', async () => {
    const res = await settle(CARD_BODY)
    await expect(res.json()).resolves.toMatchObject({ sale_ledger_outcome: 'recorded' })

    const audit = db.auditRows('payment.tab_settled')[0]
    expect((audit.metadata as Record<string, unknown>).sale_ledger_outcome).toBe('recorded')
    expect((audit.metadata as Record<string, unknown>).sale_ledger_gap).toBe(false)
  })
})

describe('a CASH settle writes NO sale row and is otherwise unchanged', () => {
  const CASH_BODY = { order_ids: ['o1'], amount: 35, method: 'cash' }

  beforeEach(() => seed({ orders: [{ id: 'o1', total: 35 }] }))

  it('settles successfully', async () => {
    const res = await settle(CASH_BODY)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true, method: 'cash' })
  })

  it('produces ZERO sale rows', async () => {
    await settle(CASH_BODY)
    expect(db.saleRows()).toHaveLength(0)
  })

  it('still marks the order paid, records the payment and audits the cash settle', async () => {
    await settle(CASH_BODY)

    expect(db.tables.orders[0].payment_status).toBe('paid')
    expect(db.tables.orders[0].payment_method).toBe('cash')
    expect(db.tables.payments).toHaveLength(1)
    expect(db.auditRows('payment.tab_settled_cash')).toHaveLength(1)
  })

  it('raises no ledger-gap alert', async () => {
    await settle(CASH_BODY)
    expect(db.auditRows(SALE_LEDGER_WRITE_FAILED_ACTION)).toHaveLength(0)
    expect(db.auditRows('payment.sale_ledger_write_skipped')).toHaveLength(0)
  })

  it('reports skipped_cash, so the absence of a row is explicable', async () => {
    const res = await settle(CASH_BODY)
    await expect(res.json()).resolves.toMatchObject({ sale_ledger_outcome: 'skipped_cash' })
  })

  it('writes no gateway reference even when a client wrongly sends one', async () => {
    await settle({ ...CASH_BODY, business_order_no: 'FT-SHOULD-NOT-STICK' })

    expect(db.saleRows()).toHaveLength(0)
    expect(db.tables.orders[0].paycloud_merchant_order_no).toBeNull()
    expect(db.tables.orders[0].payment_voucher_no).toBeNull()
  })
})

describe('the settlement survives a ledger failure', () => {
  beforeEach(() => {
    seed({ orders: [{ id: 'o1', total: 35 }] })
    db.options.failInsertOn = { payment_events: { message: 'ledger down', code: '08006' } }
  })

  it('still answers 200 and still marks the order paid — the money has moved', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await settle(CARD_BODY)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({ success: true })
      expect(db.tables.orders[0].payment_status).toBe('paid')
    } finally {
      spy.mockRestore()
    }
  })

  it('records the gap loudly instead', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await settle(CARD_BODY)

      await expect(res.json()).resolves.toMatchObject({ sale_ledger_outcome: 'failed' })
      expect(db.auditRows(SALE_LEDGER_WRITE_FAILED_ACTION)).toHaveLength(1)

      const audit = db.auditRows('payment.tab_settled')[0]
      expect((audit.metadata as Record<string, unknown>).sale_ledger_gap).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a card settle that carries no gateway reference', () => {
  beforeEach(() => seed({ orders: [{ id: 'o1', total: 35 }] }))

  it('settles, writes no row, and audits the skip rather than inventing a reference', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await settle({ order_ids: ['o1'], amount: 35, method: 'card' })

      expect(res.status).toBe(200)
      expect(db.saleRows()).toHaveLength(0)
      expect(db.auditRows('payment.sale_ledger_write_skipped')).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})
