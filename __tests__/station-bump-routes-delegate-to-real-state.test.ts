/**
 * Proves the two fixes described in app/api/terminal/station-lines/[lineId]/route.ts and
 * app/api/terminal/bar-rounds/[roundId]/route.ts's own docblocks:
 *
 *   1. A kitchen 'ready_to_run' tap now stores 'ready' (the real LineState), never the literal
 *      string 'ready_to_run' — which the real order_lines_kitchen_state_check CHECK constraint
 *      has never accepted (see lib/orders/order-lines.ts).
 *   2. Both bump routes now write order_line_events with the real columns
 *      (from_state/to_state/actor_kind/actor_user_id), never the guessed
 *      event_type/created_at/created_by shape lib/stations/schema-assumptions.ts (deleted) used.
 *   3. The bar route's one tap now writes 'ready', never the invented 'out' value.
 *
 * Same route-mocking shape __tests__/station-pairing-enforcement.test.ts already established:
 * mock lib/terminal-auth, lib/features/get-restaurant-features and lib/supabase/server, then
 * call the exported route handlers directly with a constructed Request. Unlike that file, this
 * one also exercises the DELEGATED real POST /api/station/order-lines/[lineId]/state handler
 * in-process (both terminal routes now call it directly), so the fake `order_lines` table below
 * has to support that route's own read -> conditional-update -> event-insert sequence, not just
 * the pairing gate's restaurant_terminals lookup.
 */
import { POST as bumpLinePOST } from '@/app/api/terminal/station-lines/[lineId]/route'
import { POST as bumpRoundPOST } from '@/app/api/terminal/bar-rounds/[roundId]/route'

const TERMINAL_ID = 'terminal-bump-fix-1'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

// The real POST /api/station/order-lines/[lineId]/state validates lineId as a UUID before
// touching order_lines — these have to be real UUID-shaped strings, not readable slugs, for the
// delegated calls below to reach the fake table at all.
const LINE_K1 = '5662777f-0906-4724-a67f-dc4cd191ef7d'
const LINE_K2 = 'c8916f83-8a64-451d-9d81-b070834204bc'
const LINE_K3 = 'cdb82511-35ee-480b-b7e5-931925dc837b'
const LINE_B1 = '2600da1c-168c-493b-9022-2ebc23a1429e'
const LINE_B2 = 'c5b41566-e3cb-44a1-af34-4b3fa23ece23'
const LINE_B3 = 'edce1b1a-9fca-49ac-b5cc-b29bc1476aa5'
const ORDER_1 = '11111111-1111-4111-8111-111111111111'
const ORDER_2 = '22222222-2222-4222-8222-222222222222'
const ORDER_3 = '33333333-3333-4333-8333-333333333333'

let terminalStationKind: 'kitchen' | 'bar' = 'kitchen'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: TERMINAL_ID,
    restaurantId: RESTAURANT_ID,
    deviceSerial: 'dev-1',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: TERMINAL_ID, status: 'active', restaurant_id: RESTAURANT_ID }),
}))

jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))

type Row = Record<string, unknown>

/**
 * A minimal, in-memory fake of the exact PostgREST call shapes the real
 * POST /api/station/order-lines/[lineId]/state and the two terminal bump routes make against
 * order_lines / order_line_events / restaurant_terminals. Not a general Supabase mock — just
 * enough chaining (select/update/insert/eq/not/maybeSingle, and bare-awaited queries) to run the
 * real read -> conditional-update -> audit-insert sequence against fake rows.
 */
function makeFakeSupabase(initialLines: Row[]) {
  const lines: Row[] = initialLines.map((r) => ({ ...r }))
  const events: Row[] = []

  function orderLinesTable() {
    let mode: 'select' | 'update' = 'select'
    let patch: Row | null = null
    const filters: Array<(r: Row) => boolean> = []

    const api = {
      select() {
        return api
      },
      update(p: Row) {
        mode = 'update'
        patch = p
        return api
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val)
        return api
      },
      not(col: string, op: string, val: unknown) {
        if (op === 'is' && val === null) filters.push((r) => r[col] !== null && r[col] !== undefined)
        return api
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]))
        return api
      },
      async maybeSingle() {
        const matched = lines.filter((r) => filters.every((f) => f(r)))
        if (mode === 'update' && patch) matched.forEach((r) => Object.assign(r, patch))
        return { data: matched[0] ?? null, error: null }
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const matched = lines.filter((r) => filters.every((f) => f(r)))
        if (mode === 'update' && patch) matched.forEach((r) => Object.assign(r, patch))
        resolve({ data: matched, error: null })
      },
    }
    return api
  }

  function orderLineEventsTable() {
    return {
      async insert(rowsToInsert: Row | Row[]) {
        const arr = Array.isArray(rowsToInsert) ? rowsToInsert : [rowsToInsert]
        events.push(...arr)
        return { data: arr, error: null }
      },
    }
  }

  function restaurantTerminalsTable() {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { station_kind: terminalStationKind }, error: null }),
          }),
        }),
      }),
    }
  }

  const client = {
    from(table: string) {
      if (table === 'order_lines') return orderLinesTable()
      if (table === 'order_line_events') return orderLineEventsTable()
      if (table === 'restaurant_terminals') return restaurantTerminalsTable()
      throw new Error(`unexpected table in fake: ${table}`)
    },
  }

  return { client, lines, events }
}

let fake: ReturnType<typeof makeFakeSupabase>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => fake.client,
}))

beforeEach(() => {
  terminalStationKind = 'kitchen'
})

describe('kitchen bump route delegates to the real state contract', () => {
  it("a 'ready_to_run' tap stores the real state 'ready', never the action name, and would have refused before this fix", async () => {
    fake = makeFakeSupabase([
      { id: LINE_K1, restaurant_id: RESTAURANT_ID, route_to: 'kitchen', kitchen_state: 'cooked', bar_state: null },
    ])

    const req = new Request(`http://localhost/api/terminal/station-lines/${LINE_K1}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ready_to_run' }),
    })
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId: LINE_K1 }) })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.line.kitchen_state).toBe('ready')
    expect(body.line.kitchen_state).not.toBe('ready_to_run')

    // Queried back from the fake table, same as the row this fix must actually move.
    expect(fake.lines[0].kitchen_state).toBe('ready')
  })

  it('the Cooked tap stores kitchen_state = cooked', async () => {
    fake = makeFakeSupabase([
      { id: LINE_K2, restaurant_id: RESTAURANT_ID, route_to: 'kitchen', kitchen_state: 'outstanding', bar_state: null },
    ])

    const req = new Request(`http://localhost/api/terminal/station-lines/${LINE_K2}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cooked' }),
    })
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId: LINE_K2 }) })
    expect(res.status).toBe(200)
    expect(fake.lines[0].kitchen_state).toBe('cooked')
  })

  it('writes exactly one order_line_events row with the REAL columns, not event_type/created_at/created_by', async () => {
    fake = makeFakeSupabase([
      { id: LINE_K3, restaurant_id: RESTAURANT_ID, route_to: 'kitchen', kitchen_state: 'outstanding', bar_state: null },
    ])

    const req = new Request(`http://localhost/api/terminal/station-lines/${LINE_K3}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cooked' }),
    })
    await bumpLinePOST(req, { params: Promise.resolve({ lineId: LINE_K3 }) })

    expect(fake.events).toHaveLength(1)
    const event = fake.events[0]
    expect(event).toMatchObject({
      order_line_id: LINE_K3,
      station: 'kitchen',
      from_state: 'outstanding',
      to_state: 'cooked',
      actor_kind: 'station',
      actor_user_id: null,
    })
    expect(event).not.toHaveProperty('event_type')
    expect(event).not.toHaveProperty('created_at')
    expect(event).not.toHaveProperty('created_by')
  })

  it('an invalid action is refused with 400 before anything is delegated', async () => {
    fake = makeFakeSupabase([])
    const req = new Request('http://localhost/api/terminal/station-lines/line-x', {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not_a_real_action' }),
    })
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId: 'line-x' }) })
    expect(res.status).toBe(400)
    expect(fake.events).toHaveLength(0)
  })
})

describe('bar-rounds route delegates to the real state contract, one tap straight to ready', () => {
  beforeEach(() => {
    terminalStationKind = 'bar'
  })

  it("fans one tap out into a per-line 'ready' bump for every bar-owned line in the round, never 'out'", async () => {
    fake = makeFakeSupabase([
      { id: LINE_B1, restaurant_id: RESTAURANT_ID, order_id: ORDER_1, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
      { id: LINE_B2, restaurant_id: RESTAURANT_ID, order_id: ORDER_1, route_to: 'both', kitchen_state: 'cooked', bar_state: 'outstanding' },
    ])

    const req = new Request(`http://localhost/api/terminal/bar-rounds/${ORDER_1}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake' },
    })
    const res = await bumpRoundPOST(req, { params: Promise.resolve({ roundId: ORDER_1 }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    expect(fake.lines.map((l) => l.bar_state)).toEqual(['ready', 'ready'])
    expect(fake.lines.some((l) => l.bar_state === 'out')).toBe(false)
    // The 'both' line's kitchen half must be untouched by a bar tap — independent columns.
    expect(fake.lines.find((l) => l.id === LINE_B2)?.kitchen_state).toBe('cooked')
  })

  it('writes one order_line_events row per line with the REAL columns, to_state ready', async () => {
    fake = makeFakeSupabase([
      { id: LINE_B3, restaurant_id: RESTAURANT_ID, order_id: ORDER_2, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
    ])

    const req = new Request(`http://localhost/api/terminal/bar-rounds/${ORDER_2}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake' },
    })
    await bumpRoundPOST(req, { params: Promise.resolve({ roundId: ORDER_2 }) })

    expect(fake.events).toHaveLength(1)
    expect(fake.events[0]).toMatchObject({
      order_line_id: LINE_B3,
      station: 'bar',
      from_state: 'outstanding',
      to_state: 'ready',
      actor_kind: 'station',
      actor_user_id: null,
    })
    expect(fake.events[0]).not.toHaveProperty('event_type')
    expect(fake.events[0].to_state).not.toBe('out')
  })

  it('404s when no bar-owned line exists for the round', async () => {
    fake = makeFakeSupabase([
      { id: 'line-k-only', restaurant_id: RESTAURANT_ID, order_id: ORDER_3, route_to: 'kitchen', kitchen_state: 'outstanding', bar_state: null },
    ])

    const req = new Request(`http://localhost/api/terminal/bar-rounds/${ORDER_3}`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake' },
    })
    const res = await bumpRoundPOST(req, { params: Promise.resolve({ roundId: ORDER_3 }) })
    expect(res.status).toBe(404)
    expect(fake.events).toHaveLength(0)
  })
})
