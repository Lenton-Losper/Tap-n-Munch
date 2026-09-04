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
  // The allocations read filters voided rows out with is(voided_at, null).
  chain.is = self
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
      // Split allocations, queried by the lines route since Ship 1. Empty by default: these suites
      // are about line state, and an unsplit tab is the ordinary case.
      if (table === 'order_line_allocations') return makeChain({ data: [], error: null })
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

describe('cooked progress is ADDITIVE — it must not move any existing figure', () => {
  it('a cooked line still counts as OUTSTANDING, so all_ready cannot flip early', async () => {
    // The whole reason cooked is not a fifth bucket. all_ready is `outstanding === 0`; if a plated
    // dish left the outstanding bucket, a table whose food is all under the lamp would report
    // "nothing outstanding" while the pass had touched none of it.
    lineRows = [line({ kitchen_state: 'cooked' })]
    const body = await (await call()).json()
    expect(body.summary.outstanding).toBe(1)
    expect(body.summary.ready).toBe(0)
    expect(body.all_ready).toBe(false)
  })

  it('does not change the raw state strings a legacy terminal reads', async () => {
    // serializeStateForLegacyTerminal is untouched: 'cooked' passes through as it always has.
    lineRows = [line({ kitchen_state: 'cooked' })]
    const body = await (await call()).json()
    expect(body.orders[0].lines[0].kitchen_state).toBe('cooked')
  })
})

describe('is_cooked', () => {
  it('is true when a station has plated the line', async () => {
    lineRows = [line({ kitchen_state: 'cooked' })]
    const body = await (await call()).json()
    expect(body.orders[0].lines[0].is_cooked).toBe(true)
  })

  it('is FALSE once the line is ready — the two are never both true', async () => {
    // So a client can fall through ready -> cooked -> making with nothing to disambiguate.
    lineRows = [line({ kitchen_state: 'ready' })]
    const body = await (await call()).json()
    const l = body.orders[0].lines[0]
    expect(l.is_ready).toBe(true)
    expect(l.is_cooked).toBe(false)
  })

  it('is false for a line nobody has started', async () => {
    lineRows = [line({ kitchen_state: 'outstanding' })]
    const body = await (await call()).json()
    expect(body.orders[0].lines[0].is_cooked).toBe(false)
  })

  it('is true for a both-routed line with one half plated', async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'cooked', bar_state: 'outstanding' })]
    const body = await (await call()).json()
    expect(body.orders[0].lines[0].is_cooked).toBe(true)
  })

  it('is false for a voided line', async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'voided', bar_state: 'voided' })]
    const body = await (await call()).json()
    expect(body.orders[0].lines[0].is_cooked).toBe(false)
  })
})

describe('summary.kitchen / summary.bar — the count, split by station', () => {
  it('counts each station separately', async () => {
    lineRows = [
      line({ id: 'a', kitchen_state: 'cooked' }),
      line({ id: 'b', kitchen_state: 'cooked' }),
      line({ id: 'c', kitchen_state: 'outstanding' }),
      line({ id: 'd', route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' }),
    ]
    const body = await (await call()).json()
    expect(body.summary.kitchen).toEqual({ total: 3, cooked: 2 })
    expect(body.summary.bar).toEqual({ total: 1, cooked: 0 })
  })

  it('counts BOTH halves of a both-routed line, one per station', async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'cooked', bar_state: 'outstanding' })]
    const body = await (await call()).json()
    expect(body.summary.kitchen).toEqual({ total: 1, cooked: 1 })
    expect(body.summary.bar).toEqual({ total: 1, cooked: 0 })
  })

  it('excludes a voided half from the total — a cancelled item is not work in hand', async () => {
    lineRows = [line({ route_to: 'both', kitchen_state: 'voided', bar_state: 'ready' })]
    const body = await (await call()).json()
    expect(body.summary.kitchen).toEqual({ total: 0, cooked: 0 })
    expect(body.summary.bar).toEqual({ total: 1, cooked: 0 })
  })

  it('reports zeroes for a station that owns nothing', async () => {
    lineRows = [line({ kitchen_state: 'outstanding' })]
    const body = await (await call()).json()
    expect(body.summary.bar).toEqual({ total: 0, cooked: 0 })
  })
})

describe('the precedence invariant, across every reachable pair of station states', () => {
  /**
   * WHY A MATRIX AND NOT ANOTHER EXAMPLE.
   *
   * `is_cooked` is scoped to the outstanding bucket so a client can fall through ready -> cooked
   * -> making with nothing to disambiguate. Mutating that scoping away did NOT turn any single
   * example red, and the reason is worth recording: `isLineReady` already requires every owning
   * station to be ready or collected, so a line cannot currently be ready WHILE a station reads
   * 'cooked'. The scoping is therefore defence, not behaviour — today.
   *
   * It stops being merely defence the moment isLineReady's definition widens, which is exactly the
   * kind of change this codebase makes (it widened once already, for 'collected'). So the
   * invariant is asserted directly over the whole state space rather than through one example that
   * happens not to exercise it.
   */
  const STATES = [null, 'outstanding', 'cooked', 'ready', 'collected', 'voided'] as const

  it('is_ready, is_cooked, is_collected and is_voided are mutually exclusive', async () => {
    let checked = 0
    for (const k of STATES) {
      for (const b of STATES) {
        if (k === null && b === null) continue
        lineRows = [line({ route_to: 'both', kitchen_state: k, bar_state: b })]
        const body = await (await call()).json()
        const l = body.orders[0].lines[0]
        const flags = [l.is_ready, l.is_cooked, l.is_collected, l.is_voided].filter(Boolean)
        expect({ k, b, flags: flags.length }).toEqual({ k, b, flags: flags.length <= 1 ? flags.length : 99 })
        checked += 1
      }
    }
    // The loop must actually have run — a matrix that silently iterates nothing is a green that
    // proves nothing.
    expect(checked).toBe(35)
  })

  it('every line lands in exactly one summary bucket', async () => {
    for (const k of STATES) {
      for (const b of STATES) {
        if (k === null && b === null) continue
        lineRows = [line({ route_to: 'both', kitchen_state: k, bar_state: b })]
        const body = await (await call()).json()
        const s = body.summary
        expect(s.outstanding + s.ready + s.collected + s.voided).toBe(1)
      }
    }
  })
})
