/**
 * Issue #104 — a cancelled order is still counted as money owed.
 *
 * Same defect class as the Tables view, fixed in c362efc: "is this order outstanding?" was
 * asked as `payment_status !== 'paid'`, which is true of a CANCELLED order. c362efc fixed the
 * one call site in app/api/terminal/tables/route.ts and nothing else, so the same question
 * asked in SQL as `.neq('payment_status', 'paid')` survived in four more places:
 *
 *   app/api/terminal/tabs/[tabId]/settle/route.ts   — tab total recalc, and can_close
 *   app/api/terminal/orders/[orderId]/payment/route.ts — canClose, on both the success path
 *                                                        and the corrected_to_paid path
 *
 * Effect: a table with one cancelled order can never be closed from the terminal, and the tab
 * total keeps reporting the cancelled order's money as still owed.
 *
 * The fake Supabase client below really filters and really applies updates, so the same test
 * is valid against both the SQL-side filter (before) and the JS-side partition (after) — it
 * is not asserting on which operators were called.
 */
import { OWES_MONEY_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'

const RESTAURANT_ID = 'rest-1'
const TAB_ID = 'tab-1'
const TABLE_ID = 'table-1'

type Row = Record<string, any>

/** Mutable in-memory tables. Reassigned per test by seed(). */
let mockTables: Record<string, Row[]> = {}

function seed(orders: Row[]) {
  mockTables = {
    tabs: [
      { id: TAB_ID, table_id: TABLE_ID, restaurant_id: RESTAURANT_ID, total: 0, status: 'open', settled_at: null },
    ],
    orders: orders.map((o) => ({
      restaurant_id: RESTAURANT_ID,
      tab_id: TAB_ID,
      terminal_pushed_at: null,
      paycloud_merchant_order_no: null,
      status: 'pending',
      ...o,
    })),
    payments: [],
    audit_logs: [],
  }
}

function project(row: Row, columns: string | undefined): Row {
  if (!columns || columns.includes('*')) return { ...row }
  const out: Row = {}
  for (const raw of columns.split(',')) {
    const col = raw.trim()
    if (!col) continue
    out[col] = row[col] ?? null
  }
  return out
}

class FakeQuery {
  private preds: Array<(row: Row) => boolean> = []
  private columns: string | undefined
  private patch: Row | null = null

  constructor(private table: string) {}

  private rows(): Row[] {
    return (mockTables[this.table] ?? []).filter((r) => this.preds.every((p) => p(r)))
  }

  select(columns?: string) {
    this.columns = columns
    return this
  }
  eq(col: string, val: unknown) {
    this.preds.push((r) => r[col] === val)
    return this
  }
  neq(col: string, val: unknown) {
    this.preds.push((r) => r[col] !== val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.preds.push((r) => vals.includes(r[col]))
    return this
  }
  is(col: string, val: unknown) {
    this.preds.push((r) => (r[col] ?? null) === val)
    return this
  }
  or(_expr: string): never {
    // Only the CASH claim uses .or(); these tests settle by CARD. Throwing loudly beats
    // silently matching everything and turning a real conflict into a green test.
    throw new Error('FakeQuery.or() is not modelled — this test covers the card path only')
  }
  update(patch: Row) {
    this.patch = patch
    return this
  }
  insert(rows: Row | Row[]) {
    const list = Array.isArray(rows) ? rows : [rows]
    mockTables[this.table] = [...(mockTables[this.table] ?? []), ...list]
    return this
  }
  async single() {
    const found = this.rows()
    if (found.length !== 1) return { data: null, error: { message: 'not found' } }
    return { data: project(found[0], this.columns), error: null }
  }
  then(resolve: (r: { data: Row[]; error: null }) => unknown) {
    const matched = this.rows()
    if (this.patch) {
      for (const row of matched) Object.assign(row, this.patch)
    }
    return Promise.resolve(resolve({ data: matched.map((r) => project(r, this.columns)), error: null }))
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => new FakeQuery(table),
  }),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_ID,
    terminalId: 'term-1',
    deviceSerial: 'SN-1',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
  safeIssueReceiptForOrder: async () => undefined,
}))

jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))

/** Both single-order payment outcomes mark the order paid for real, as the live helpers do. */
function markPaidInFakeDb(orderId: string) {
  const row = (mockTables.orders ?? []).find((o) => o.id === orderId)
  if (row) row.payment_status = 'paid'
}

jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: async (_c: unknown, params: { orderId: string }) => {
    markPaidInFakeDb(params.orderId)
    return { claimed: true, orderId: params.orderId, tabId: TAB_ID }
  },
}))

jest.mock('@/lib/payments/handle-terminal-payment-failed', () => ({
  handleTerminalPaymentFailed: async (_c: unknown, params: { orderId: string }) => {
    markPaidInFakeDb(params.orderId)
    return { outcome: 'corrected_to_paid', tabId: TAB_ID }
  },
}))

// Imported after the mocks so the routes pick them up.
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as payOneOrder } from '@/app/api/terminal/orders/[orderId]/payment/route'

async function callSettle(orderIds: string[], amount: number) {
  const res = await settleTab(
    new Request('https://example.test/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_ids: orderIds, amount, method: 'card', gateway_reference: 'GW-1' }),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function callPayOrder(orderId: string, status: 'success' | 'failed', amount: number) {
  const res = await payOneOrder(
    new Request('https://example.test/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, amount, reference: 'REF-1' }),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

const storedTabTotal = () => mockTables.tabs[0].total

describe('#104 — tab settle: a cancelled order is not money owed', () => {
  it('lets the tab close once the last order that owes money is settled', async () => {
    seed([
      { id: 'o-paid', total: 50, payment_status: 'paid' },
      { id: 'o-cancelled', total: 30, payment_status: 'cancelled' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { status, body } = await callSettle(['o-pending'], 20)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.can_close).toBe(true)
  })

  it('recalculates the tab total without the cancelled order', async () => {
    seed([
      { id: 'o-cancelled', total: 30, payment_status: 'cancelled' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { body } = await callSettle(['o-pending'], 20)

    expect(body.new_tab_total).toBe(0)
    expect(body.tab_total_stale).toBe(false)
    expect(storedTabTotal()).toBe(0)
  })

  it("does not count a 'Paid' row whose casing SQL equality would miss", async () => {
    seed([
      { id: 'o-oddcase', total: 40, payment_status: 'Paid' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { body } = await callSettle(['o-pending'], 20)

    expect(body.new_tab_total).toBe(0)
    expect(body.can_close).toBe(true)
  })

  // CONTROL — must hold before and after the fix. Without it, "cancelled no longer counts"
  // could be satisfied by a filter that counts nothing at all.
  it.each([...OWES_MONEY_PAYMENT_STATUSES].filter((s) => s !== 'terminal_pending'))(
    'still reports a %s sibling as outstanding, and still refuses to close',
    async (siblingStatus) => {
      seed([
        { id: 'o-owing', total: 30, payment_status: siblingStatus },
        { id: 'o-pending', total: 20, payment_status: 'pending' },
      ])

      const { body } = await callSettle(['o-pending'], 20)

      expect(body.new_tab_total).toBe(30)
      expect(body.can_close).toBe(false)
    },
  )

  it('still counts a terminal_pending sibling as outstanding', async () => {
    seed([
      { id: 'o-inflight', total: 30, payment_status: 'terminal_pending' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { body } = await callSettle(['o-pending'], 20)

    expect(body.new_tab_total).toBe(30)
    expect(body.can_close).toBe(false)
  })
})

describe.each([
  ['success path', 'success' as const],
  ['corrected_to_paid path', 'failed' as const],
])('#104 — single-order terminal payment (%s): canClose ignores cancelled orders', (_l, reqStatus) => {
  it('reports canClose once the only order that owed money is paid', async () => {
    seed([
      { id: 'o-cancelled', total: 30, payment_status: 'cancelled' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { status, body } = await callPayOrder('o-pending', reqStatus, 20)

    expect(status).toBe(200)
    expect(body.canClose).toBe(true)
  })

  // CONTROL — a real debt must still block the close on the same path.
  it('still refuses canClose while a cash_pending sibling is outstanding', async () => {
    seed([
      { id: 'o-owing', total: 30, payment_status: 'cash_pending' },
      { id: 'o-pending', total: 20, payment_status: 'pending' },
    ])

    const { body } = await callPayOrder('o-pending', reqStatus, 20)

    expect(body.canClose).toBe(false)
  })
})
