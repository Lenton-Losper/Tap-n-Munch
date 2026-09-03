/**
 * Proves the fix for "Bar presses Out, the P5 terminal keeps showing Being made" at its root:
 * POST /api/station/order-lines/[lineId]/state — the one place kitchen_state/bar_state are ever
 * written (station-lines/batch, station-lines/[lineId] and bar-rounds/[roundId] all delegate to
 * it, see __tests__/station-bump-routes-delegate-to-real-state.test.ts) — now tells the world a
 * change happened, via lib/stations/realtime-invalidate.ts's restaurant-scoped broadcast.
 *
 * REPRODUCES THE GAP FIRST: the two 'no broadcast' cases below (double-tap, refused write) are
 * the negative space that proves this is invalidation of a REAL change, not a poke on every
 * request — a terminal that refetched on every no-op would be back to hammering the API the
 * spec explicitly ruled out.
 */
import { POST } from '@/app/api/station/order-lines/[lineId]/state/route'
import { restaurantLinesChannelName, restaurantLinesPrivateChannelName, LINE_CHANGED_EVENT } from '@/lib/stations/realtime-invalidate'

const RESTAURANT_ID = 'b2000277-eefa-40d1-ad1f-2f01282a1652'
const LINE_ID = '5662777f-0906-4724-a67f-dc4cd191ef7d'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'terminal-1',
    restaurantId: RESTAURANT_ID,
    deviceSerial: 'dev-1',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'terminal-1', status: 'active', restaurant_id: RESTAURANT_ID }),
}))

jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))

type Row = Record<string, unknown>

function makeFakeSupabase(initialLine: Row, opts: { channelThrows?: boolean; privateChannelThrows?: boolean } = {}) {
  const line: Row = { ...initialLine }
  const events: Row[] = []
  const channelCalls: string[] = []
  const httpSendCalls: Array<{ event: string; payload: unknown }> = []

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
      async maybeSingle() {
        const matches = filters.every((f) => f(line))
        if (!matches) return { data: null, error: null }
        if (mode === 'update' && patch) Object.assign(line, patch)
        return { data: { ...line }, error: null }
      },
    }
    return api
  }

  const client = {
    from(table: string) {
      if (table === 'order_lines') return orderLinesTable()
      if (table === 'order_line_events') {
        return {
          async insert(row: Row) {
            events.push(row)
            return { data: [row], error: null }
          },
        }
      }
      throw new Error(`unexpected table in fake: ${table}`)
    },
    channel(name: string) {
      channelCalls.push(name)
      return {
        async httpSend(event: string, payload: unknown) {
          if (opts.channelThrows) throw new Error('simulated broadcast transport failure')
          // Phase B: the private topic is the new, unproven one. A failure there must not be
          // able to take down the send the whole estate is listening to.
          if (opts.privateChannelThrows && name.startsWith('restaurant-lines-private:')) {
            throw new Error('simulated private broadcast failure')
          }
          httpSendCalls.push({ event, payload })
          return { success: true }
        },
      }
    },
  }

  return { client, line, events, channelCalls, httpSendCalls }
}

let fake: ReturnType<typeof makeFakeSupabase>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => fake.client,
}))

function request(body: Row) {
  return new Request(`http://localhost/api/station/order-lines/${LINE_ID}/state`, {
    method: 'POST',
    headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('a real state change broadcasts an invalidation', () => {
  it('sends line_changed on the restaurant-scoped channel after cooked -> ready', async () => {
    fake = makeFakeSupabase({
      id: LINE_ID,
      restaurant_id: RESTAURANT_ID,
      route_to: 'bar',
      kitchen_state: null,
      bar_state: 'cooked',
    })

    const res = await POST(request({ station: 'bar', to_state: 'ready' }), {
      params: Promise.resolve({ lineId: LINE_ID }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unchanged).toBe(false)
    expect(body.line.bar_state).toBe('ready')

    // DUAL-PUBLISH (Phase B). The public topic every till and wall screen in the estate is
    // currently listening on, AND the new private one. Both, on every real state change, for as
    // long as any client remains on the old build -- retiring the public send before they have
    // moved would strand them on their 45s/60s polls, silently.
    expect(fake.channelCalls).toEqual([
      restaurantLinesChannelName(RESTAURANT_ID),
      restaurantLinesPrivateChannelName(RESTAURANT_ID),
    ])
    expect(fake.httpSendCalls).toHaveLength(2)
    expect(fake.httpSendCalls.map((c) => c.event)).toEqual([LINE_CHANGED_EVENT, LINE_CHANGED_EVENT])
    // Invalidation only -- no line id, no item name, no table number in the wire payload, on
    // EITHER channel. The terminal's own GET (already terminal-JWT gated) is what may carry that.
    // The private channel does not get to become the place data leaks just because it is private.
    expect(fake.httpSendCalls[0].payload).toEqual({})
    expect(fake.httpSendCalls[1].payload).toEqual({})
  })

  it('does NOT broadcast on a double-tap (already at the target state)', async () => {
    fake = makeFakeSupabase({
      id: LINE_ID,
      restaurant_id: RESTAURANT_ID,
      route_to: 'bar',
      kitchen_state: null,
      bar_state: 'ready',
    })

    const res = await POST(request({ station: 'bar', to_state: 'ready' }), {
      params: Promise.resolve({ lineId: LINE_ID }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unchanged).toBe(true)
    expect(fake.channelCalls).toHaveLength(0)
  })

  it('does NOT broadcast when the write is refused (voided line)', async () => {
    fake = makeFakeSupabase({
      id: LINE_ID,
      restaurant_id: RESTAURANT_ID,
      route_to: 'bar',
      kitchen_state: null,
      bar_state: 'voided',
    })

    const res = await POST(request({ station: 'bar', to_state: 'ready' }), {
      params: Promise.resolve({ lineId: LINE_ID }),
    })

    expect(res.status).toBe(409)
    expect(fake.channelCalls).toHaveLength(0)
  })

  it('a broadcast transport failure does not fail the request -- the state change already landed', async () => {
    fake = makeFakeSupabase(
      { id: LINE_ID, restaurant_id: RESTAURANT_ID, route_to: 'bar', kitchen_state: null, bar_state: 'cooked' },
      { channelThrows: true },
    )

    const res = await POST(request({ station: 'bar', to_state: 'ready' }), {
      params: Promise.resolve({ lineId: LINE_ID }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.line.bar_state).toBe('ready')
    // The write is real regardless of what the broadcast did.
    expect(fake.line.bar_state).toBe('ready')
  })

  it('still sends on the PUBLIC channel when the private one fails', async () => {
    // The load-bearing property of settling the two sends independently. The private topic is new
    // and, until the third-party auth provider is registered, has no subscribers at all. If a
    // rejection there could skip the public send, a Phase B problem would present as every board
    // and till in the estate going quiet -- the worst possible failure, caused by the safest
    // possible change. Promise.all would do exactly that; Promise.allSettled is why it cannot.
    fake = makeFakeSupabase(
      {
        id: LINE_ID,
        restaurant_id: RESTAURANT_ID,
        route_to: 'bar',
        kitchen_state: null,
        bar_state: 'cooked',
      },
      { privateChannelThrows: true },
    )

    const res = await POST(request({ station: 'bar', to_state: 'ready' }), {
      params: Promise.resolve({ lineId: LINE_ID }),
    })

    // The write itself is unaffected: a broadcast is best-effort and never fails the request.
    expect(res.status).toBe(200)
    expect((await res.json()).line.bar_state).toBe('ready')

    // Both were attempted; only the public one landed.
    expect(fake.channelCalls).toEqual([
      restaurantLinesChannelName(RESTAURANT_ID),
      restaurantLinesPrivateChannelName(RESTAURANT_ID),
    ])
    expect(fake.httpSendCalls).toHaveLength(1)
    expect(fake.httpSendCalls[0].event).toBe(LINE_CHANGED_EVENT)
  })
})
