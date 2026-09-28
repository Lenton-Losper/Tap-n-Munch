/**
 * CONTRACT C3 -- what the amend route answers, and what it records.
 *
 * Riviera Table 1, order #160: a tester believed a N$240 Modena Pasta was cancelled. Production
 * shows it never was, and nothing anywhere recorded an attempt. The terminal now treats a line as
 * cancelled ONLY when its id is in `applied` -- so the one thing this file has to prove is that
 * `applied`, `changed` and `lines` come from what amend_order_lines REPORTED, never from what the
 * request ASKED for. The "fabrication" test below is the one that fails if they ever do.
 *
 * The RPC's own behaviour (refusals, atomicity, races) is proven against real Postgres in
 * supabase/tests/amend-rpc.test.sql and amend-race.test.sh; here it is a queue of canned answers.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/amend/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const PASTA = '22222222-2222-4222-8222-222222222222'
const BEER = '33333333-3333-4333-8333-333333333333'
const TOKEN = '44444444-4444-4444-8444-444444444444'
const MANAGER = '55555555-5555-4555-8555-555555555555'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    restaurantId: 'rest-1',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))

jest.mock('@/lib/orders/order-number', () => {
  const actual = jest.requireActual('@/lib/orders/order-number')
  return { ...actual, nextOrderNumber: async () => 700 }
})

const broadcasts: string[] = []
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  broadcastLineChanged: async (_s: unknown, restaurantId: string) => {
    broadcasts.push(restaurantId)
  },
}))

let consumeResult: { ok: true } | { ok: false; reason: string } = { ok: true }
const consumeCalls: unknown[] = []
jest.mock('@/lib/terminal-auth/consume-authorization-token', () => ({
  consumeAuthorizationToken: async (_s: unknown, params: unknown) => {
    consumeCalls.push(params)
    return consumeResult
  },
}))

type Update = { table: string; values: Record<string, unknown>; filters: Array<[string, string, unknown]> }
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
let rpcResponses: Array<{ data: unknown; error: unknown }> = []
let updates: Update[] = []
let currentLines: Array<{ id: string; quantity: number; name_snapshot: string }> = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return rpcResponses.shift() ?? { data: null, error: { message: 'no mock response queued' } }
    },
    from: (table: string) => {
      let update: Update | null = null
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (values: Record<string, unknown>) => {
          update = { table, values, filters: [] }
          updates.push(update)
          return builder
        },
        eq: (col: string, v: unknown) => (update?.filters.push(['eq', col, v]), builder),
        in: (col: string, v: unknown) => (update?.filters.push(['in', col, v]), builder),
        is: (col: string, v: unknown) => (update?.filters.push(['is', col, v]), builder),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: update ? null : table === 'order_lines' ? currentLines : [], error: null }),
      }
      return builder
    },
  }),
}))

function call(body: unknown) {
  return POST(
    new Request('https://example.test/api/terminal/tabs/x/amend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) },
  )
}

const pinned = (amendments: unknown[], extra: Record<string, unknown> = {}) => ({
  amendments,
  staff_user_id: MANAGER,
  authorization_token_id: TOKEN,
  void_reason: 'customer changed their mind',
  ...extra,
})

const reasonWrites = () => updates.filter((u) => u.table === 'order_line_events')
const outcomeWrites = () => updates.filter((u) => u.table === 'authorization_events')
const filter = (u: Update, op: string, col: string) => u.filters.find((f) => f[0] === op && f[1] === col)?.[2]

beforeEach(() => {
  rpcCalls = []
  rpcResponses = []
  updates = []
  broadcasts.length = 0
  consumeCalls.length = 0
  consumeResult = { ok: true }
  currentLines = [
    { id: PASTA, quantity: 2, name_snapshot: 'Modena Pasta' },
    { id: BEER, quantity: 3, name_snapshot: 'Lager' },
  ]
})

describe('success', () => {
  it('a full void: applied, changed, a voided line, the reason on the void event', async () => {
    rpcResponses.push({
      data: { order_id: null, order_number: null, applied: [{ line_id: PASTA, action: 'voided' }], refused: [] },
      error: null,
    })
    const res = await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, changed: true, applied: [{ line_id: PASTA, action: 'voided' }], refused: [] })
    expect(body.lines).toEqual([
      { line_id: PASTA, name: 'Modena Pasta', outcome: 'voided', previous_quantity: 2, quantity: 0 },
    ])
    expect(rpcCalls[0].args.p_actor_user_id).toBe(MANAGER)
    const [w] = reasonWrites()
    expect(w.values).toEqual({ void_reason: 'customer changed their mind' })
    expect(filter(w, 'in', 'order_line_id')).toEqual([PASTA])
    expect(broadcasts).toEqual([RESTAURANT])
  })

  it('a REDUCTION writes the void reason too (it used to be dropped for every "replaced" line)', async () => {
    rpcResponses.push({
      data: {
        order_id: 'order-new', order_number: 700,
        applied: [{ line_id: BEER, action: 'replaced', new_line_id: 'line-new' }], refused: [],
      },
      error: null,
    })
    const res = await call(pinned([{ line_id: BEER, new_quantity: 1 }]))
    const body = await res.json()
    expect(body.changed).toBe(true)
    expect(body.lines).toEqual([
      { line_id: BEER, name: 'Lager', outcome: 'reduced', previous_quantity: 3, quantity: 1, new_line_id: 'line-new' },
    ])
    const writes = reasonWrites()
    expect(writes).toHaveLength(1)
    expect(filter(writes[0], 'in', 'order_line_id')).toEqual([BEER])
    expect(filter(writes[0], 'eq', 'to_state')).toBe('voided')
    expect(filter(writes[0], 'is', 'void_reason')).toBeNull()
  })

  it('partial: one voided, one refused -- lines say which is which', async () => {
    rpcResponses.push({
      data: {
        order_id: null, order_number: null,
        applied: [{ line_id: BEER, action: 'voided' }],
        refused: [{ line_id: PASTA, reason: 'window_closed' }],
      },
      error: null,
    })
    const body = await (await call(pinned([
      { line_id: PASTA, new_quantity: 0 },
      { line_id: BEER, new_quantity: 0 },
    ]))).json()
    expect(body.changed).toBe(true)
    expect(body.lines).toEqual([
      { line_id: PASTA, name: 'Modena Pasta', outcome: 'refused', previous_quantity: 2, quantity: 2, refusal_reason: 'window_closed' },
      { line_id: BEER, name: 'Lager', outcome: 'voided', previous_quantity: 3, quantity: 0 },
    ])
    // The reason goes only on what was actually voided.
    expect(filter(reasonWrites()[0], 'in', 'order_line_id')).toEqual([BEER])
    expect(outcomeWrites()[0].values.detail).toMatchObject({ outcome: 'partial' })
  })
})

describe('all refused is a 200 that says nothing changed', () => {
  it.each(['window_closed', 'order_paid', 'line_settled', 'not_found'])(
    '%s: changed false, no applied, a refused line, no reason write, no broadcast',
    async (reason) => {
      rpcResponses.push({
        data: { order_id: null, order_number: null, applied: [], refused: [{ line_id: PASTA, reason }] },
        error: null,
      })
      const res = await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.changed).toBe(false)
      expect(body.applied).toEqual([])
      expect(body.refused).toEqual([{ line_id: PASTA, reason }])
      expect(body.lines).toEqual([
        { line_id: PASTA, name: 'Modena Pasta', outcome: 'refused', previous_quantity: 2, quantity: 2, refusal_reason: reason },
      ])
      expect(reasonWrites()).toHaveLength(0)
      expect(broadcasts).toHaveLength(0)
    },
  )

  it('an already-voided line (the RPC answers window_closed) is refused, not re-reported as cancelled', async () => {
    rpcResponses.push({
      data: { order_id: null, order_number: null, applied: [], refused: [{ line_id: PASTA, reason: 'window_closed' }] },
      error: null,
    })
    const body = await (await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))).json()
    expect(body.changed).toBe(false)
    expect(body.lines[0].outcome).toBe('refused')
  })

  it('the refusal is recorded DURABLY on the consumed PIN event, so refused != never sent', async () => {
    rpcResponses.push({
      data: { order_id: null, order_number: null, applied: [], refused: [{ line_id: PASTA, reason: 'order_paid' }] },
      error: null,
    })
    await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
    const [w] = outcomeWrites()
    expect(filter(w, 'eq', 'token_id')).toBe(TOKEN)
    expect(filter(w, 'eq', 'event_type')).toBe('consumed')
    expect(filter(w, 'eq', 'restaurant_id')).toBe(RESTAURANT)
    expect(w.values.detail).toMatchObject({
      action: 'line_void',
      tab_id: TAB_ID,
      outcome: 'all_refused',
      void_reason: 'customer changed their mind',
      applied: [],
      refused: [{ line_id: PASTA, reason: 'order_paid' }],
      requested: [{ line_id: PASTA, new_quantity: 0 }],
    })
  })
})

describe('applied comes from the RPC, never from the request', () => {
  it('an RPC that reports NOTHING for a requested line: not cancelled, reported not_reported', async () => {
    rpcResponses.push({ data: { order_id: null, order_number: null, applied: [], refused: [] }, error: null })
    const body = await (await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))).json()
    expect(body.changed).toBe(false)
    expect(body.applied).toEqual([])
    expect(body.lines).toEqual([
      { line_id: PASTA, name: 'Modena Pasta', outcome: 'refused', previous_quantity: 2, quantity: 2, refusal_reason: 'not_reported' },
    ])
    expect(reasonWrites()).toHaveLength(0)
  })

  it('a malformed RPC result reads as nothing applied', async () => {
    rpcResponses.push({ data: null, error: null })
    const res = await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toBe(false)
    expect(body.applied).toEqual([])
    expect(body.lines[0].outcome).toBe('refused')
  })

  it('reports only the lines the RPC applied when the request asked for more', async () => {
    rpcResponses.push({
      data: { order_id: null, order_number: null, applied: [{ line_id: BEER, action: 'voided' }], refused: [] },
      error: null,
    })
    const body = await (await call(pinned([
      { line_id: PASTA, new_quantity: 0 },
      { line_id: BEER, new_quantity: 0 },
    ]))).json()
    expect(body.applied).toEqual([{ line_id: BEER, action: 'voided' }])
    expect(body.lines.find((l: { line_id: string }) => l.line_id === PASTA).outcome).toBe('refused')
  })
})

describe('refusals before the RPC keep their codes and spend nothing', () => {
  it('VOID_NEEDS_AUTHORIZATION (403) without a token', async () => {
    const res = await call({ amendments: [{ line_id: PASTA, new_quantity: 0 }], void_reason: 'x' })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('VOID_NEEDS_AUTHORIZATION')
    expect(rpcCalls).toHaveLength(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('VOID_NEEDS_REASON (400) without a reason', async () => {
    const res = await call(pinned([{ line_id: PASTA, new_quantity: 1 }], { void_reason: '  ' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('VOID_NEEDS_REASON')
    expect(rpcCalls).toHaveLength(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('AUTHORIZATION_INVALID (403) when the token is rejected', async () => {
    consumeResult = { ok: false, reason: 'already_used' }
    const res = await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('AUTHORIZATION_INVALID')
    expect(body.reason).toBe('already_used')
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('an RPC error', () => {
  it('502 AMEND_FAILED, the token is spent, nothing reported applied, the failure is recorded', async () => {
    rpcResponses.push({ data: null, error: { code: '42P01', message: 'boom' } })
    const res = await call(pinned([{ line_id: PASTA, new_quantity: 0 }]))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('AMEND_FAILED')
    expect(body.applied).toBeUndefined()
    expect(body.changed).toBeUndefined()
    expect(consumeCalls).toHaveLength(1)
    expect(rpcCalls).toHaveLength(1)
    expect(reasonWrites()).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
    expect(outcomeWrites()[0].values.detail).toMatchObject({ outcome: 'amend_failed', applied: [] })
  })
})

describe('an amendment that reduces nothing', () => {
  it('needs no PIN and records no authorization outcome', async () => {
    rpcResponses.push({
      data: { order_id: 'o', order_number: 700, applied: [{ line_id: PASTA, action: 'replaced', new_line_id: 'n' }], refused: [] },
      error: null,
    })
    const body = await (await call({ amendments: [{ line_id: PASTA, new_quantity: 4 }] })).json()
    expect(body.changed).toBe(true)
    expect(body.lines[0]).toMatchObject({ outcome: 'increased', previous_quantity: 2, quantity: 4 })
    expect(consumeCalls).toHaveLength(0)
    expect(outcomeWrites()).toHaveLength(0)
    expect(rpcCalls[0].args.p_actor_user_id).toBeNull()
  })
})
