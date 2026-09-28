/**
 * RIVIERA TABLE 1, ORDER #160 -- THE MODENA SEQUENCE, END TO END THROUGH THE REAL ROUTES.
 *
 * A tester believed a N$240 Modena Pasta was cancelled. Production showed it never was, nothing
 * anywhere recorded an attempt, and every money surface read the tab differently. The per-surface
 * suites (terminal-tabs-amend-c3, terminal-tabs-lines-financials, terminal-tables-live-outstanding,
 * prepare-payment-charges-live-outstanding, tab-settle-amended-tab) each seed their own model of an
 * amended tab. This file walks ONE tab through the whole sequence, and the rows under it are the
 * rows the REAL `amend_order_lines` wrote in Postgres (supabase/tests/riviera-modena-chain.test.sql,
 * replayed by ./helpers/modena-rpc-replay.ts -- the replay refuses any call or pre-state that differs
 * from what the database saw).
 *
 *   PLACED       N$1,945   Modena 240 · 2x WYWH 380 · 2x Salmon 920 · 2x Burger 180 · Jameson 80
 *                          · Hansa 80 · Soft Drinks 35 · Mixers 30
 *   3 REDUCTIONS N$1,205   WYWH, Burger, Salmon 2 -> 1, each through the amend route with a PIN
 *   A  APPLIED   N$965     Modena voided: authorised, attributed, kitchen voided, every surface 965
 *   B  REFUSED   N$1,205   Modena cooked first: window_closed, nothing moves
 *   C/D          timeout / network failure: see the terminal (named below); server side, a request
 *                that never arrived changed nothing, and a lost RESPONSE is recovered by the re-read
 *   E            the #160 basket re-sent EDITED under the same key: 409 with what the server has
 *
 * Only auth, the feature flag, the realtime broadcast and the payment-gateway credentials are
 * replaced. Everything that decides or reads money runs for real.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import {
  LINE,
  MANAGER,
  O160,
  R,
  SNAP,
  TAB,
  TERMINAL,
  applyState,
  diffAgainst,
  mintToken,
  replayingRpc,
  seedModenaDb,
  type ModenaStep,
} from './helpers/modena-rpc-replay'
import { computeOrderFinancials, readProjectionInputs, type FinancialOrderInput } from '@/lib/orders/order-financials'

let mockDb: InMemoryDb
let mockReplay: ReturnType<typeof replayingRpc> | null = null
const problems: string[] = []
const broadcasts: string[] = []
const intents: Array<Record<string, unknown>> = []

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: '11111111-1111-4111-8111-111111111111',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0160',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  broadcastLineChanged: async (_s: unknown, restaurantId: string) => {
    broadcasts.push(restaurantId)
  },
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'M', storeNo: 'S' }),
}))
jest.mock('@/lib/payments/terminal-merchant-order', () => ({
  ensureTerminalMerchantOrderNo: async () => ({ merchantOrderNo: 'MO-MODENA-1', created: true }),
}))
jest.mock('@/lib/payments/payment-intents', () => ({
  ensureOrdersIntent: async (_s: unknown, params: Record<string, unknown>) => {
    intents.push(params)
    return { id: 'intent-modena' }
  },
}))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true, unavailable: [] }),
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({ safeIssueReceiptsForOrders: async () => undefined }))
jest.mock('@/lib/tables/table-owners', () => ({ loadTableOwners: async () => new Map() }))
// The browser client module is imported (restaurants.ts) but must not build a real client.
jest.mock('@/lib/supabase/client', () => ({
  supabase: new Proxy({}, { get: (_t, key) => (mockDb.client() as Record<string | symbol, unknown>)[key] }),
}))
jest.mock('@/lib/api/require-staff-permission', () => ({
  requireUrlRestaurantPermission: async () => ({ userId: 'staff-1' }),
  isAuthError: () => false,
}))

/**
 * Two query shapes the store does not model, served from the SAME store so they read what the
 * routes wrote: the tables view's nested select (restaurant_tables -> tabs -> orders), and the cash
 * claim's `.or()` (every order here is pending, so its payment_status.in(...) half is all of it).
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const base = mockDb.client()
    return {
      ...base,
      rpc: (name: string, args: Record<string, unknown>) =>
        mockReplay ? mockReplay.rpc(name, args) : base.rpc(name, args),
      from(table: string) {
        if (table === 'restaurant_tables') {
          const rows = () =>
            mockDb.rows('restaurant_tables').filter((t) => t.status === 'occupied').map((t) => ({
              ...t,
              tabs: mockDb
                .rows('tabs')
                .filter((tab) => tab.table_id === t.id && ['open', 'ready_to_pay'].includes(String(tab.status)))
                .map((tab) => ({ ...tab, orders: mockDb.rows('orders').filter((o) => o.tab_id === tab.id) })),
            }))
          const b: Record<string, unknown> = {}
          Object.assign(b, {
            select: () => b,
            eq: () => b,
            in: () => b,
            order: () => b,
            then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
          })
          return b
        }
        const q = base.from(table) as unknown as Record<string, unknown> & { in: (c: string, v: unknown[]) => unknown }
        q.or = (expr: string) => {
          const m = /^payment_status\.in\.\(([^)]*)\),/.exec(expr)
          if (!m) throw new Error(`unmodelled .or(${expr})`)
          return q.in('payment_status', m[1].split(','))
        }
        return q
      },
    }
  },
}))

import { POST as amendRoute } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { GET as linesRoute } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { GET as tablesRoute } from '@/app/api/terminal/tables/route'
import { POST as prepareRoute } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as settleRoute } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as bumpRoute } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as historyRoute } from '@/app/api/orders/history/route'
import { POST as roundsRoute } from '@/app/api/terminal/rounds/route'

const VOID_REASON = 'customer changed their mind'

type Json = Record<string, any>

async function amend(lineId: string, quantity: number, token: string) {
  const res = await amendRoute(
    new Request(`https://x.test/api/terminal/tabs/${TAB}/amend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amendments: [{ line_id: lineId, new_quantity: quantity }],
        staff_user_id: MANAGER,
        authorization_token_id: token,
        void_reason: VOID_REASON,
      }),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function lines() {
  const res = await linesRoute(new Request(`https://x.test/api/terminal/tabs/${TAB}/lines`), {
    params: Promise.resolve({ tabId: TAB }),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function tables() {
  const res = await tablesRoute(new Request('https://x.test/api/terminal/tables'))
  const body = (await res.json()) as { tables: Json[] }
  return { status: res.status, table: body.tables[0] }
}

async function prepare(orderIds: string[]) {
  const res = await prepareRoute(
    new NextRequest(`http://localhost/api/terminal/orders/${O160}/prepare-payment`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds }),
    }),
    { params: Promise.resolve({ orderId: O160 }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function settleCash(orderIds: string[], amount: number) {
  const res = await settleRoute(
    new NextRequest(`http://localhost/api/terminal/tabs/${TAB}/settle`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds, amount, method: 'cash' }),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function bump(lineId: string, station: 'kitchen' | 'bar', toState: string) {
  const res = await bumpRoute(
    new Request(`https://x.test/api/station/order-lines/${lineId}/state`, {
      method: 'POST',
      body: JSON.stringify({ station, to_state: toState }),
    }),
    { params: Promise.resolve({ lineId }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function history() {
  const res = await historyRoute(
    new Request(`https://x.test/api/orders/history?restaurantId=${R}&startDate=2026-09-24&endDate=2026-09-24`),
  )
  return { status: res.status, body: (await res.json()) as Json }
}

const tabOrderIds = () =>
  mockDb
    .rows('orders')
    .filter((o) => o.tab_id === TAB)
    .sort((a, b) => Number(a.order_number) - Number(b.order_number))
    .map((o) => String(o.id))
const orderByNumber = (n: number) => mockDb.rows('orders').find((o) => Number(o.order_number) === n)!
const lineRow = (id: string) => mockDb.rows('order_lines').find((l) => l.id === id)!
const voidEventsFor = (lineId: string) =>
  mockDb.rows('order_line_events').filter((e) => e.order_line_id === lineId && e.to_state === 'voided')
const eventFor = (token: string) => mockDb.rows('authorization_events').find((e) => e.token_id === token)
const tokenRow = (token: string) => mockDb.rows('privileged_authorization_tokens').find((t) => t.id === token)!
/** Every line on the tab the P5 would put on the bill: not voided. */
const payable = (body: Json) =>
  (body.orders as Json[]).flatMap((o) => o.lines as Json[]).filter((l) => l.is_voided !== true)

function start(branch: 'a' | 'b') {
  problems.length = 0
  broadcasts.length = 0
  intents.length = 0
  mockDb = seedModenaDb()
  // Branch B re-ran the reductions from a fresh seed, so it carries its own three reduction steps.
  const steps: ModenaStep[] = branch === 'a' ? [...SNAP.reductions, ...SNAP.branch_a] : SNAP.branch_b
  mockReplay = replayingRpc(mockDb, steps, problems, async (name) => ({
    data: null,
    error: { message: `unstubbed rpc ${name}` },
  }))
  for (let i = 1; i <= 4; i += 1) mintToken(mockDb, `0000aaaa-0000-4000-8000-00000000000${i}`)
}
const TOKEN = (i: number) => `0000aaaa-0000-4000-8000-00000000000${i}`

/** The three reductions production recorded, each through the real route with its own PIN. */
async function reduceThree() {
  for (const [i, line] of [LINE.wywh, LINE.burger, LINE.salmon].entries()) {
    const r = await amend(line, 1, TOKEN(i + 1))
    expect(r.status).toBe(200)
    expect(r.body.changed).toBe(true)
    expect(r.body.lines[0]).toMatchObject({ line_id: line, outcome: 'reduced', previous_quantity: 2, quantity: 1 })
  }
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  jest.restoreAllMocks()
  mockReplay = null
})

describe('the three reductions: N$1,945 placed, N$1,205 live, on every surface', () => {
  it('each reduction is authorised, attributed, gives its reason, and the bill reads N$1,205', async () => {
    start('a')
    const before = await lines()
    expect(before.body.tab.total).toBe(1945)

    await reduceThree()
    expect(problems).toEqual([])
    expect(diffAgainst(mockDb, SNAP.reductions[2].post)).toBeNull()

    for (const [i, line] of [LINE.wywh, LINE.burger, LINE.salmon].entries()) {
      expect(tokenRow(TOKEN(i + 1)).used_at).not.toBeNull()
      expect(voidEventsFor(line)).toEqual([
        expect.objectContaining({ actor_user_id: MANAGER, from_state: 'outstanding', void_reason: VOID_REASON }),
      ])
    }
    const after = await lines()
    expect(after.body.tab.total).toBe(1205)
    expect(after.body.financials.tab).toEqual({
      original_cents: 268500,
      voided_cents: 148000,
      live_cents: 120500,
      paid_cents: 0,
      outstanding_cents: 120500,
      overpaid_cents: 0,
    })
    expect((await tables()).table.tab.unpaid_total).toBe(1205)
  })
})

describe('A. Modena cancelled -- the void APPLIES', () => {
  async function walk() {
    start('a')
    await reduceThree()
    const r = await amend(LINE.modena, 0, TOKEN(4))
    expect(problems).toEqual([])
    return r
  }

  it('the route says voided -- from what the database applied', async () => {
    const r = await walk()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      success: true,
      changed: true,
      applied: [{ line_id: LINE.modena, action: 'voided' }],
      refused: [],
    })
    expect(r.body.lines).toEqual([
      { line_id: LINE.modena, name: 'Modena Pasta', outcome: 'voided', previous_quantity: 1, quantity: 0 },
    ])
    expect(broadcasts).toHaveLength(4)
  })

  it('the rows: kitchen voided, one attributed void event WITH its reason, no replacement order, #160 untouched', async () => {
    await walk()
    expect(diffAgainst(mockDb, SNAP.branch_a[0].post)).toBeNull()
    expect(lineRow(LINE.modena)).toMatchObject({ kitchen_state: 'voided', bar_state: null })
    expect(voidEventsFor(LINE.modena)).toEqual([
      expect.objectContaining({
        station: 'kitchen',
        from_state: 'outstanding',
        actor_kind: 'terminal',
        actor_user_id: MANAGER,
        void_reason: VOID_REASON,
      }),
    ])
    expect(tabOrderIds()).toHaveLength(4)
    expect(orderByNumber(160).total).toBe(1945) // never rewritten; the projection subtracts
  })

  it('the authorization: the PIN token is spent, and the consumed event records what was applied', async () => {
    await walk()
    expect(tokenRow(TOKEN(4)).used_at).not.toBeNull()
    const consumed = mockDb.rows('authorization_events').filter((e) => e.token_id === TOKEN(4))
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({
      event_type: 'consumed',
      actor_user_id: MANAGER,
      restaurant_id: R,
      terminal_id: TERMINAL,
      detail: {
        action: 'line_void',
        tab_id: TAB,
        outcome: 'applied',
        void_reason: VOID_REASON,
        requested: [{ line_id: LINE.modena, new_quantity: 0 }],
        applied: [{ line_id: LINE.modena, action: 'voided' }],
        refused: [],
      },
    })
  })

  it('the P5 bill: N$965, Modena marked voided and not payable, the payable lines sum to N$965', async () => {
    await walk()
    const { status, body } = await lines()
    expect(status).toBe(200)
    expect(body.tab.total).toBe(965)
    expect(body.financials.tab).toMatchObject({ live_cents: 96500, outstanding_cents: 96500, paid_cents: 0 })
    expect(body.financials.orders[O160]).toMatchObject({ original_cents: 194500, voided_cents: 172000, live_cents: 22500 })

    const modena = (body.orders as Json[]).flatMap((o) => o.lines as Json[]).find((l) => l.id === LINE.modena)
    expect(modena).toMatchObject({ is_voided: true, kitchen_state: 'voided' })
    const bill = payable(body)
    expect(bill.some((l) => l.name_snapshot === 'Modena Pasta')).toBe(false)
    expect(bill.reduce((s, l) => s + Number(l.total_cents), 0)).toBe(96500)
    expect(body.summary.voided).toBe(4)
  })

  it('the floor view, the order history and the dashboard read path all read N$965 / N$225', async () => {
    await walk()
    const t = await tables()
    expect(t.table.tab.unpaid_total).toBe(965)
    expect(t.table.tab.financials).toMatchObject({ live_cents: 96500, outstanding_cents: 96500 })
    expect(t.table.can_close).toBe(false)

    const h = await history()
    expect(h.status).toBe(200)
    const row160 = (h.body.orders as Json[]).find((o) => o.id === O160)
    expect(row160).toMatchObject({ order_amount: 1945, live_amount: 225, voided_amount: 1720 })
    const liveSum = (h.body.orders as Json[]).reduce((s, o) => s + Math.round(Number(o.live_amount) * 100), 0)
    expect(liveSum).toBe(96500)

    // components/orders-dashboard.tsx: readProjectionInputs + computeOrderFinancials over its rows.
    const inputs = await readProjectionInputs(mockDb.client(), tabOrderIds())
    const dash = mockDb
      .rows('orders')
      .filter((o) => o.tab_id === TAB)
      .map((o) => computeOrderFinancials(o as unknown as FinancialOrderInput, inputs.lines, 0))
    expect(dash.find((f) => f.orderId === O160)).toMatchObject({ liveCents: 22500, voidedCents: 172000 })
    expect(dash.reduce((s, f) => s + f.liveCents, 0)).toBe(96500)
  })

  it('the card charge: prepare-payment asks for N$965, per order EXACTLY what settle_order_payment then verified', async () => {
    await walk()
    const ids = tabOrderIds()
    const { status, body } = await prepare(ids)
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(96500)
    expect(intents[0]).toMatchObject({ amountCents: 96500 })

    // The rows the SQL suite handed to settle_order_payment, written there by the same rule.
    const prepared = SNAP.branch_a.find((s) => s.kind === 'prepare_payment')!
    const byNumber = (rows: Array<Record<string, unknown>>) =>
      rows
        .filter((o) => o.tab_id === TAB)
        .sort((a, b) => Number(a.order_number) - Number(b.order_number))
        .map((o) => [o.order_number, o.pending_charge_cents])
    expect(byNumber(mockDb.rows('orders'))).toEqual(byNumber(prepared.post.orders))
    expect(byNumber(mockDb.rows('orders'))).toEqual([[160, 22500], [161, 19000], [162, 9000], [163, 46000]])

    // ...and the database accepted a N$965 gateway amount against exactly those rows.
    const settled = SNAP.branch_a.find((s) => s.kind === 'settle_order_payment')!
    expect(settled.result).toMatchObject({ ok: true, reason: 'settled' })
    mockReplay!.advanceTo(settled)
    applyState(mockDb, settled.post)
    expect(mockDb.rows('payment_events')).toEqual([expect.objectContaining({ amount: 965, event_type: 'sale' })])
    expect(byNumber(mockDb.rows('orders')).map(([n]) => n)).toEqual([160, 161, 162, 163])
    expect(mockDb.rows('orders').map((o) => o.settled_charge_cents).reduce((s, c) => Number(s) + Number(c), 0)).toBe(96500)
    const after = await lines()
    expect(after.body.financials.tab).toMatchObject({ live_cents: 96500, paid_cents: 96500, outstanding_cents: 0, overpaid_cents: 0 })
  })

  it('the cash settlement: N$1,205 is refused as AMOUNT_MISMATCH (expected 965); N$965 is taken and recorded', async () => {
    await walk()
    const ids = tabOrderIds()
    const stale = await settleCash(ids, 1205)
    expect(stale.status).toBe(400)
    expect(stale.body).toMatchObject({ code: 'AMOUNT_MISMATCH', expected: 965, received: 1205 })
    expect(mockDb.rows('orders').every((o) => o.payment_status === 'pending')).toBe(true)

    const ok = await settleCash(ids, 965)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ success: true, method: 'cash', new_tab_total: 0, can_close: true })
    expect(mockDb.rows('payments')).toEqual([expect.objectContaining({ amount: 965, method: 'cash' })])
    expect(
      mockDb
        .rows('orders')
        .sort((a, b) => Number(a.order_number) - Number(b.order_number))
        .map((o) => o.settled_charge_cents),
    ).toEqual([22500, 19000, 9000, 46000])
  })
})

describe('B. Modena already cooked -- the void is REFUSED and nothing moves', () => {
  async function walk() {
    start('b')
    await reduceThree()
    const cooked = await bump(LINE.modena, 'kitchen', 'cooked')
    expect(cooked.status).toBe(200)
    const station = SNAP.branch_b.find((s) => s.kind === 'station')!
    // The station route put the store where the SQL suite put the database before the refusal.
    expect(diffAgainst(mockDb, station.post)).toBeNull()
    mockReplay!.advanceTo(station)
    const r = await amend(LINE.modena, 0, TOKEN(4))
    expect(problems).toEqual([])
    return r
  }

  it('the route says refused, window_closed, changed false -- never "cancelled"', async () => {
    const r = await walk()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      success: true,
      changed: false,
      applied: [],
      refused: [{ line_id: LINE.modena, reason: 'window_closed' }],
    })
    expect(r.body.lines).toEqual([
      {
        line_id: LINE.modena,
        name: 'Modena Pasta',
        outcome: 'refused',
        previous_quantity: 1,
        quantity: 1,
        refusal_reason: 'window_closed',
      },
    ])
  })

  it('no void event, Modena still cooked and on the bill, N$1,205 everywhere', async () => {
    await walk()
    expect(voidEventsFor(LINE.modena)).toEqual([])
    expect(lineRow(LINE.modena).kitchen_state).toBe('cooked')
    expect(tabOrderIds()).toHaveLength(4)
    const { body } = await lines()
    expect(body.tab.total).toBe(1205)
    expect(payable(body).some((l) => l.id === LINE.modena)).toBe(true)
    expect((await tables()).table.tab.unpaid_total).toBe(1205)
    expect((await prepare(tabOrderIds())).body.chargeCents).toBe(120500)
  })

  it('the refusal is still RECORDED: the spent PIN carries outcome all_refused with the reason', async () => {
    await walk()
    expect(eventFor(TOKEN(4))).toMatchObject({
      event_type: 'consumed',
      detail: {
        outcome: 'all_refused',
        applied: [],
        refused: [{ line_id: LINE.modena, reason: 'window_closed' }],
        void_reason: VOID_REASON,
      },
    })
  })
})

describe('C/D. timeout and network failure', () => {
  /**
   * The terminal's half is D:\RN\ft-sales src/components/__tests__/amendSheetOutcomes.test.tsx
   * ("Modena, TIMEOUT" / "Modena, SERVER 502": "Cancellation NOT confirmed — check the table") and
   * src/lib/__tests__/cancelPathWireContract.test.ts (a timeout / network failure rejects as
   * RequestOutcomeUnknownError, never a result). What only the server can prove is below.
   */
  it('a request that never reached the server changed nothing: N$1,205, Modena outstanding, PIN unspent', async () => {
    start('a')
    await reduceThree()
    // (the terminal's amend POST times out before it is sent -- no route call)
    expect(tokenRow(TOKEN(4)).used_at).toBeNull()
    expect(eventFor(TOKEN(4))).toBeUndefined()
    expect(lineRow(LINE.modena).kitchen_state).toBe('outstanding')
    expect(voidEventsFor(LINE.modena)).toEqual([])
    expect((await lines()).body.tab.total).toBe(1205)
    expect(mockReplay!.remaining()).toBeGreaterThan(0) // the void step was never consumed
  })

  it('a LOST RESPONSE (the server applied it, the answer never arrived): the re-read the terminal does shows the truth', async () => {
    start('a')
    await reduceThree()
    await amend(LINE.modena, 0, TOKEN(4)) // response discarded, as a timed-out client would
    const { body } = await lines()
    expect(body.tab.total).toBe(965)
    const modena = (body.orders as Json[]).flatMap((o) => o.lines as Json[]).find((l) => l.id === LINE.modena)
    expect(modena?.is_voided).toBe(true)
  })

  it('a retry of the same cancellation with the spent PIN is refused before the RPC and voids nothing twice', async () => {
    start('a')
    await reduceThree()
    await amend(LINE.modena, 0, TOKEN(4))
    const retry = await amend(LINE.modena, 0, TOKEN(4))
    expect(retry.status).toBe(403)
    expect(retry.body).toMatchObject({ code: 'AUTHORIZATION_INVALID', reason: 'already_used' })
    expect(problems).toEqual([]) // the RPC was not called again
    expect(voidEventsFor(LINE.modena)).toHaveLength(1)
  })
})

describe('E. the #160 basket re-sent EDITED under the same idempotency key', () => {
  /**
   * The Riviera shape: Send failed on the device, the waiter took Modena off the basket and sent
   * again -- reusing the key. The server used to answer with the ORIGINAL round as a success, so the
   * kitchen made the removed pasta and the device said "Round sent". The real rounds route, the real
   * createOrder and pricing, and the real order-lines writer run here against one store.
   */
  const CAT_KITCHEN = 'cccc0001-0000-4000-8000-000000000001'
  const CAT_BAR = 'cccc0001-0000-4000-8000-000000000002'
  const MENU: Array<[string, string, number, 'kitchen' | 'bar']> = [
    ['dddddddd-0000-4000-8000-0000000001d0', 'Modena Pasta', 240, 'kitchen'],
    ['dddddddd-0000-4000-8000-0000000001d1', 'Wish You Were Here', 190, 'kitchen'],
    ['dddddddd-0000-4000-8000-0000000001d2', 'Seared Salmon', 460, 'kitchen'],
    ['dddddddd-0000-4000-8000-0000000001d3', 'Double Cheese Burger', 90, 'kitchen'],
    ['dddddddd-0000-4000-8000-0000000001d4', 'Jameson', 80, 'bar'],
    ['dddddddd-0000-4000-8000-0000000001d5', 'Hansa', 80, 'bar'],
    ['dddddddd-0000-4000-8000-0000000001d6', 'Soft Drinks', 35, 'bar'],
    ['dddddddd-0000-4000-8000-0000000001d7', 'Mixers', 30, 'bar'],
  ]
  const QTY: Record<string, number> = { 'Wish You Were Here': 2, 'Seared Salmon': 2, 'Double Cheese Burger': 2 }
  const basket = (without: string[] = []) =>
    MENU.filter(([, name]) => !without.includes(name)).map(([id, name, price]) => ({
      menuItemId: id,
      name,
      quantity: QTY[name] ?? 1,
      price, // a client figure; the server reprices and ignores it
    }))

  function freshTab() {
    problems.length = 0
    mockReplay = null
    mockDb = seedModenaDb({
      menu_categories: [
        { id: CAT_KITCHEN, restaurant_id: R, name: 'Kitchen', route_to: 'kitchen' },
        { id: CAT_BAR, restaurant_id: R, name: 'Bar', route_to: 'bar' },
      ],
      menu_items: MENU.map(([id, name, price, route]) => ({
        id,
        restaurant_id: R,
        name,
        base_price: price,
        sizes: [],
        addons: [],
        variants: null,
        variant_groups: null,
        tax_rate_id: 'abab0001-0000-4000-8000-000000000015',
        status: 'available',
        category_id: route === 'kitchen' ? CAT_KITCHEN : CAT_BAR,
      })),
    })
    // The tab as it was before #160 was sent: open, nothing on it.
    mockDb.tables.orders = []
    mockDb.tables.order_lines = []
    // orders_restaurant_idempotency_key_unique (partial: key NOT NULL). Every order in this world
    // carries a key, so the store's plain tuple rule is the same constraint. An identical replay
    // depends on it: createOrder's 23505 branch is what hands the ORIGINAL order back.
    mockDb.rules.orders = { unique: [['restaurant_id', 'idempotency_key']] }
  }

  async function send(items: unknown[], key: string) {
    const res = await roundsRoute(
      new Request('https://x.test/api/terminal/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': key },
        body: JSON.stringify({ tab_id: TAB, items, subtotal: 1, total: 1 }),
      }),
    )
    return { status: res.status, body: (await res.json()) as Json }
  }

  it('first send: one round of N$1,945 priced by the server, eight lines for the stations', async () => {
    freshTab()
    const r = await send(basket(), 'key-160')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, duplicate: false, lines_written: true, line_count: 8 })
    expect(mockDb.rows('orders')).toHaveLength(1)
    expect(mockDb.rows('orders')[0].total).toBe(1945)
    expect(mockDb.rows('order_lines').map((l) => l.name_snapshot)).toContain('Modena Pasta')
  })

  it('EDITED re-send (Modena removed, same key): 409 with the items the server ACTUALLY has, nothing written', async () => {
    freshTab()
    const first = await send(basket(), 'key-160')
    const edited = await send(basket(['Modena Pasta']), 'key-160')
    expect(edited.status).toBe(409)
    expect(edited.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_BODY_MISMATCH',
      order_id: first.body.order_id,
      order_number: first.body.order_number,
    })
    // The server's truth -- Modena IS on it -- never the device's edited basket.
    const names = (edited.body.items as Json[]).map((i) => i.name)
    expect(names).toContain('Modena Pasta')
    expect(names).toHaveLength(8)
    expect(mockDb.rows('orders')).toHaveLength(1)
    expect(mockDb.rows('order_lines')).toHaveLength(8)
    expect(mockDb.rows('orders')[0].total).toBe(1945)
  })

  it('an IDENTICAL replay is a duplicate, not a second round; the edited basket needs a NEW key', async () => {
    freshTab()
    const first = await send(basket(), 'key-160')
    const replay = await send(basket(), 'key-160')
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ duplicate: true, order_id: first.body.order_id, line_count: 8 })
    expect(mockDb.rows('orders')).toHaveLength(1)

    const fresh = await send(basket(['Modena Pasta']), 'key-160-b')
    expect(fresh.status).toBe(200)
    expect(mockDb.rows('orders')).toHaveLength(2)
    expect(mockDb.rows('orders')[1].total).toBe(1705)
  })
})
