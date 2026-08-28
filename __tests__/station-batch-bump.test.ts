/**
 * POST /api/terminal/station-lines/batch — the server half of the per-table "all cooked" and the
 * per-round "all out".
 *
 * The three properties that make it a shortcut rather than a blunt instrument, each of which would
 * be a real service incident if it broke:
 *
 *   1. It acts on EXACTLY the ids the card sent. Not "every line on the order" — the card was
 *      painted from a snapshot, and a line added since is a line nobody at the station has seen.
 *   2. It does not drag a line BACKWARDS. The single-line contract underneath will write 'cooked'
 *      over 'ready' for a deliberate correction; fanned out across a table that would pull a plate
 *      the pass already ran back onto the board.
 *   3. A partial failure is reported per line, not collapsed into one status. Without that the card
 *      shrinks from five rows to two and reads exactly like a table where three dishes are still
 *      being cooked.
 *
 * Same fake-PostgREST shape as __tests__/station-bump-routes-delegate-to-real-state.test.ts, and for
 * the same reason: this route delegates to the REAL
 * POST /api/station/order-lines/[lineId]/state handler in-process, so the fake has to support that
 * route's own read -> conditional-update -> audit-insert sequence, not just this one's pre-read.
 */
import { POST as batchPOST } from '@/app/api/terminal/station-lines/batch/route'

const TERMINAL_ID = 'terminal-batch-1'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

// The delegate validates lineId as a UUID before touching order_lines, so these have to be real
// UUID-shaped strings rather than readable slugs.
const L1 = '5662777f-0906-4724-a67f-dc4cd191ef7d'
const L2 = 'c8916f83-8a64-451d-9d81-b070834204bc'
const L3 = 'cdb82511-35ee-480b-b7e5-931925dc837b'
const L4 = '2600da1c-168c-493b-9022-2ebc23a1429e'
const L5 = 'c5b41566-e3cb-44a1-af34-4b3fa23ece23'
const NOT_OURS = 'edce1b1a-9fca-49ac-b5cc-b29bc1476aa5'
const ORDER = '11111111-1111-4111-8111-111111111111'

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

  const client = {
    from(table: string) {
      if (table === 'order_lines') return orderLinesTable()
      if (table === 'order_line_events') {
        return {
          async insert(rowsToInsert: Row | Row[]) {
            const arr = Array.isArray(rowsToInsert) ? rowsToInsert : [rowsToInsert]
            events.push(...arr)
            return { data: arr, error: null }
          },
        }
      }
      if (table === 'restaurant_terminals') {
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
      throw new Error(`unexpected table in fake: ${table}`)
    },
  }

  return { client, lines, events }
}

let fake: ReturnType<typeof makeFakeSupabase>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => fake.client,
}))

function kitchenLine(id: string, kitchenState: string | null, barState: string | null = null): Row {
  return {
    id,
    order_id: ORDER,
    restaurant_id: RESTAURANT_ID,
    route_to: barState === null ? 'kitchen' : 'both',
    kitchen_state: kitchenState,
    bar_state: barState,
  }
}

function request(body: unknown) {
  return new Request('http://localhost/api/terminal/station-lines/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  terminalStationKind = 'kitchen'
})

describe('one tap, exactly the lines the card sent', () => {
  it('moves every named line and leaves an unnamed line on the same order alone', async () => {
    fake = makeFakeSupabase([
      kitchenLine(L1, 'outstanding'),
      kitchenLine(L2, 'outstanding'),
      // On the SAME order, and deliberately not in the request: a line added after the card was
      // painted, which nobody at the station has seen.
      kitchenLine(L3, 'outstanding'),
    ])

    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L2] }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.moved).toBe(2)
    expect(fake.lines.find((l) => l.id === L1)!.kitchen_state).toBe('cooked')
    expect(fake.lines.find((l) => l.id === L2)!.kitchen_state).toBe('cooked')
    expect(fake.lines.find((l) => l.id === L3)!.kitchen_state).toBe('outstanding')
  })

  it('writes one audit event per line that actually moved, and none for the ones that did not', async () => {
    fake = makeFakeSupabase([kitchenLine(L1, 'outstanding'), kitchenLine(L2, 'ready')])

    await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L2] }))

    expect(fake.events).toHaveLength(1)
    expect(fake.events[0]).toMatchObject({
      order_line_id: L1,
      station: 'kitchen',
      from_state: 'outstanding',
      to_state: 'cooked',
      actor_kind: 'station',
    })
  })

  /**
   * THE ONE THAT WOULD HAVE BEEN A SERVICE INCIDENT.
   *
   * The single-line contract accepts 'cooked' from any non-void state, on purpose — a deliberate tap
   * correcting a mis-bump is legitimate. Fanned out over a table it is not: the pass ran table 4's
   * steak two seconds before the cook hit "all cooked", and without this guard that steak comes back
   * onto the board as un-passed food.
   *
   * Made to fail on purpose: deleting the STATE_PROGRESS check in the route and letting every id
   * through turned this line's state back to 'cooked' and wrote a second, false, ready->cooked audit
   * row. Both assertions below failed.
   */
  it('never drags a line backwards — one already at or past the target is skipped, not rewritten', async () => {
    fake = makeFakeSupabase([
      kitchenLine(L1, 'outstanding'),
      kitchenLine(L2, 'cooked'),
      kitchenLine(L3, 'ready'),
    ])

    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L2, L3] }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['moved', 'skipped', 'skipped'])
    // The line the pass already ran is untouched, and no event claims otherwise.
    expect(fake.lines.find((l) => l.id === L3)!.kitchen_state).toBe('ready')
    expect(fake.events.filter((e) => e.order_line_id === L3)).toHaveLength(0)
  })

  it('refuses a line this station does not own rather than reaching into the other board', async () => {
    // bar_state set, kitchen_state null: the bar's half of a bar-only line.
    fake = makeFakeSupabase([
      kitchenLine(L1, 'outstanding'),
      { id: L4, order_id: ORDER, restaurant_id: RESTAURANT_ID, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
    ])

    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L4] }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('BATCH_PARTIALLY_FAILED')
    expect(body.results[1]).toMatchObject({ line_id: L4, outcome: 'failed', code: 'STATION_DOES_NOT_OWN_LINE' })
    expect(fake.lines.find((l) => l.id === L4)!.bar_state).toBe('outstanding')
  })

  it('never touches a line belonging to another restaurant', async () => {
    fake = makeFakeSupabase([kitchenLine(L1, 'outstanding'), { ...kitchenLine(NOT_OURS, 'outstanding'), restaurant_id: 'someone-else' }])

    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, NOT_OURS] }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.results[1]).toMatchObject({ line_id: NOT_OURS, outcome: 'failed', code: 'LINE_NOT_FOUND' })
    expect(fake.lines.find((l) => l.id === NOT_OURS)!.kitchen_state).toBe('outstanding')
  })
})

describe('three of five', () => {
  /**
   * The partial-failure contract the card is built on: the three that moved STAY moved, the two that
   * did not are each named, and the status says the whole thing did not succeed.
   *
   * Rolling the three back was considered and rejected — it would mean un-cooking food that is
   * cooked, writing three false audit events to undo three true ones, and making a cook re-tap work
   * they had already done because of a line they never touched.
   *
   * Made to fail on purpose: dropping `results` from the 409 body — leaving only a count, which is
   * what a route reporting "some of that did not work" would naturally return — left the card with
   * nothing to mark, and this test died on the per-line lookup below.
   */
  it('keeps what moved, names what did not, and says the whole tap did not succeed', async () => {
    fake = makeFakeSupabase([
      kitchenLine(L1, 'outstanding'),
      kitchenLine(L2, 'outstanding'),
      kitchenLine(L3, 'outstanding'),
      kitchenLine(L4, 'voided'),
      { id: L5, order_id: ORDER, restaurant_id: RESTAURANT_ID, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
    ])

    const res = await batchPOST(
      request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L2, L3, L4, L5] }),
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.ok).toBe(false)
    expect(body.total).toBe(5)
    expect(body.moved).toBe(3)

    const byId = Object.fromEntries(
      body.results.map((r: { line_id: string; outcome: string; code: string | null }) => [r.line_id, r]),
    )
    expect(byId[L1].outcome).toBe('moved')
    expect(byId[L2].outcome).toBe('moved')
    expect(byId[L3].outcome).toBe('moved')
    expect(byId[L4]).toMatchObject({ outcome: 'failed', code: 'LINE_VOIDED' })
    expect(byId[L5]).toMatchObject({ outcome: 'failed', code: 'STATION_DOES_NOT_OWN_LINE' })

    // The three that landed are NOT rolled back.
    for (const id of [L1, L2, L3]) {
      expect(fake.lines.find((l) => l.id === id)!.kitchen_state).toBe('cooked')
    }
  })

  it('returns the results in the order the card sent them, so rows can be lined up against them', async () => {
    fake = makeFakeSupabase([kitchenLine(L1, 'outstanding'), kitchenLine(L2, 'outstanding'), kitchenLine(L3, 'outstanding')])

    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L3, L1, L2] }))
    const body = await res.json()

    expect(body.results.map((r: { line_id: string }) => r.line_id)).toEqual([L3, L1, L2])
  })
})

describe('the bar uses the same route, for the same reasons', () => {
  it("sends a round's named lines straight to ready, with no 'cooked' step", async () => {
    terminalStationKind = 'bar'
    fake = makeFakeSupabase([
      { id: L1, order_id: ORDER, restaurant_id: RESTAURANT_ID, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
      { id: L2, order_id: ORDER, restaurant_id: RESTAURANT_ID, route_to: 'bar', kitchen_state: null, bar_state: 'outstanding' },
    ])

    const res = await batchPOST(request({ station: 'bar', action: 'out', line_ids: [L1, L2] }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.moved).toBe(2)
    expect(fake.lines.map((l) => l.bar_state)).toEqual(['ready', 'ready'])
    // And never the invented 'out' value, which no CHECK constraint has ever accepted.
    expect(fake.events.map((e) => e.to_state)).toEqual(['ready', 'ready'])
  })

  it("leaves the kitchen's half of a 'both' line alone", async () => {
    terminalStationKind = 'bar'
    fake = makeFakeSupabase([kitchenLine(L1, 'outstanding', 'outstanding')])

    await batchPOST(request({ station: 'bar', action: 'out', line_ids: [L1] }))

    const line = fake.lines.find((l) => l.id === L1)!
    expect(line.bar_state).toBe('ready')
    expect(line.kitchen_state).toBe('outstanding')
  })
})

describe('what it refuses at the door', () => {
  beforeEach(() => {
    fake = makeFakeSupabase([kitchenLine(L1, 'outstanding')])
  })

  it('refuses an empty list rather than reporting a successful no-op', async () => {
    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_LINE_IDS')
  })

  it("refuses 'ready_to_run' as a STATE — it is an action name and has never been a stored value", async () => {
    const res = await batchPOST(request({ station: 'kitchen', action: 'ready_to_run', line_ids: [L1] }))
    expect(res.status).toBe(200)
    // The action is legal; what it STORES is the real vocabulary.
    expect(fake.lines[0].kitchen_state).toBe('ready')
  })

  it('refuses an unknown action and an unknown station', async () => {
    expect((await batchPOST(request({ station: 'kitchen', action: 'incinerate', line_ids: [L1] }))).status).toBe(400)
    expect((await batchPOST(request({ station: 'grill', action: 'cooked', line_ids: [L1] }))).status).toBe(400)
  })

  it('refuses a non-UUID id before it can reach a write path', async () => {
    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: ['not-a-uuid'] }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_LINE_IDS')
  })

  it('de-duplicates, so the same id twice cannot report a phantom no-op', async () => {
    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1, L1] }))
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(fake.events).toHaveLength(1)
  })

  it('refuses a screen paired to the OTHER station', async () => {
    terminalStationKind = 'bar'
    const res = await batchPOST(request({ station: 'kitchen', action: 'cooked', line_ids: [L1] }))
    expect(res.status).toBe(403)
    expect(fake.lines[0].kitchen_state).toBe('outstanding')
  })
})
