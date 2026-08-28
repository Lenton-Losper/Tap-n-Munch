/**
 * GET /api/terminal/tabs/[tabId]/lines -- two 'collected' (20260829160000) compat concerns, one
 * cosmetic and one real. Both are documented in the route itself; this file pins the behaviour.
 *
 * 1. serializeStateForLegacyTerminal: the raw kitchen_state/bar_state strings a pre-collected
 *    terminal might display literally. Downgraded to 'ready' -- harmless, "picked up" and "ready"
 *    both mean nothing left to do.
 *
 * 2. bucketForLine: the AGGREGATE the floor badge counts. THIS is the bug the terminal handover
 *    flagged -- "FOOD UP never clears" -- because is_ready/summary.ready used to reuse
 *    isLineReady()'s general answer, which treats collected as still-ready. A collected line must
 *    NOT count toward 'ready' here, or the badge that tells a waiter "go collect this" can only
 *    ever turn on.
 */
import { GET } from '@/app/api/terminal/tabs/[tabId]/lines/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    restaurantId: RESTAURANT,
    permissions: ['orders:read'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))

type Row = Record<string, unknown>

let tabRow: Row | null
let lineRows: Row[]
let orderRows: Row[]

/** A chain that is both fluent (every method returns itself) and thenable, resolving to the
 *  canned result for whichever table `.from()` was called with — the same shape this repo's own
 *  tests already use for chained Supabase mocks (see station-setup-status-route.test.ts). */
function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.select = self
  chain.eq = self
  chain.order = self
  chain.in = self
  chain.maybeSingle = () => Promise.resolve(result)
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return chain
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'tabs') return makeChain({ data: tabRow, error: null })
      if (table === 'order_lines') return makeChain({ data: lineRows, error: null })
      if (table === 'orders') return makeChain({ data: orderRows, error: null })
      throw new Error(`unexpected table in test: ${table}`)
    },
  }),
}))

function call() {
  return GET(new Request('https://example.test/api/terminal/tabs/x/lines'), {
    params: Promise.resolve({ tabId: TAB_ID }),
  })
}

function line(overrides: Row): Row {
  return {
    id: 'line-1',
    order_id: 'order-1',
    source_item_index: 0,
    name_snapshot: 'Ribeye',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  tabRow = { id: TAB_ID, table_number: '4', status: 'open', total: 0, opened_by_user_id: null, created_at: new Date().toISOString() }
  lineRows = []
  orderRows = [{ id: 'order-1', order_number: 100, placed_at: new Date().toISOString(), order_instructions: null, total: 0 }]
})

describe("kitchen_state/bar_state string: 'collected' reads as 'ready' for a pre-collected terminal", () => {
  it("downgrades a kitchen-only collected line's raw state to 'ready'", async () => {
    lineRows = [line({ kitchen_state: 'collected' })]
    const res = await call()
    const body = await res.json()
    expect(body.orders[0].lines[0].kitchen_state).toBe('ready')
  })

  it("downgrades a bar_state of 'collected' independently of the kitchen half", async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'cooked', bar_state: 'collected' })]
    const res = await call()
    const body = await res.json()
    const returned = body.orders[0].lines[0]
    expect(returned.kitchen_state).toBe('cooked')
    expect(returned.bar_state).toBe('ready')
  })

  it('leaves every other state untouched', async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'outstanding', bar_state: 'cooked' })]
    const res = await call()
    const body = await res.json()
    const returned = body.orders[0].lines[0]
    expect(returned.kitchen_state).toBe('outstanding')
    expect(returned.bar_state).toBe('cooked')
  })
})

describe('the FOOD-UP signal: a collected line must not count as ready', () => {
  /**
   * THE BUG, MADE TO FAIL FIRST. Before bucketForLine existed, `is_ready` reused isLineReady()
   * directly, which returns true for 'collected' -- so this exact case asserted `is_ready: true`
   * and `summary.ready: 1`. That is what "FOOD UP never clears" looked like from this route.
   */
  it('a fully collected line is is_ready: false and counted in summary.collected, not summary.ready', async () => {
    lineRows = [line({ kitchen_state: 'collected' })]
    const res = await call()
    const body = await res.json()

    const returned = body.orders[0].lines[0]
    expect(returned.is_ready).toBe(false)
    expect(returned.is_collected).toBe(true)
    expect(body.summary.ready).toBe(0)
    expect(body.summary.collected).toBe(1)
    expect(body.summary.outstanding).toBe(0)
  })

  it('a line still sitting ready IS is_ready: true and counts in summary.ready', async () => {
    lineRows = [line({ kitchen_state: 'ready' })]
    const res = await call()
    const body = await res.json()

    const returned = body.orders[0].lines[0]
    expect(returned.is_ready).toBe(true)
    expect(returned.is_collected).toBe(false)
    expect(body.summary.ready).toBe(1)
    expect(body.summary.collected).toBe(0)
  })

  /**
   * PER LINE, still. A 'both' line with one half collected and one half still ready has SOMETHING
   * on a pass waiting for a waiter -- it must count as ready, not collected, until both halves
   * are picked up.
   */
  it("a 'both' line with one half ready and one half collected still counts as ready overall", async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'collected', bar_state: 'ready' })]
    const res = await call()
    const body = await res.json()

    const returned = body.orders[0].lines[0]
    expect(returned.is_ready).toBe(true)
    expect(returned.is_collected).toBe(false)
    expect(body.summary.ready).toBe(1)
    expect(body.summary.collected).toBe(0)
  })

  it("a 'both' line only counts as collected once BOTH halves are collected", async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'collected', bar_state: 'collected' })]
    const res = await call()
    const body = await res.json()

    const returned = body.orders[0].lines[0]
    expect(returned.is_collected).toBe(true)
    expect(body.summary.collected).toBe(1)
  })

  /**
   * THE SIGNAL A REAL SERVICE PRODUCES: a table where everything has been collected must report
   * zero ready lines -- this is the exact shape "FOOD UP never clears" described, on a tab with
   * multiple rounds instead of one line in isolation.
   */
  it('a table where every line has been collected reports summary.ready: 0 and all_ready: true', async () => {
    lineRows = [
      line({ id: 'l1', kitchen_state: 'collected' }),
      line({ id: 'l2', route_to: 'both', kitchen_state: 'collected', bar_state: 'collected' }),
    ]
    const res = await call()
    const body = await res.json()

    expect(body.summary.ready).toBe(0)
    expect(body.summary.collected).toBe(2)
    expect(body.summary.outstanding).toBe(0)
    // all_ready is unaffected by the collected split -- nothing is still being made.
    expect(body.all_ready).toBe(true)
  })

  it('voided still takes priority over collected -- a voided line is never counted as collected', async () => {
    lineRows = [line({ kitchen_state: 'voided' })]
    const res = await call()
    const body = await res.json()

    const returned = body.orders[0].lines[0]
    expect(returned.is_voided).toBe(true)
    expect(returned.is_collected).toBe(false)
    expect(body.summary.voided).toBe(1)
    expect(body.summary.collected).toBe(0)
  })
})
