/**
 * feat/station-screens-v1 — stationScreensEnabled default OFF: prove the three station API
 * routes are UNREACHABLE, not merely that the resulting screen renders empty. FNB ChowNow and
 * Mingle trade tomorrow morning and never opt into this feature — this is what proves neither
 * can be affected by it.
 *
 * The scenario under test is deliberately the DANGEROUS one: a VALID terminal JWT for a real
 * terminal (requireTerminalAuth and validateTerminalRecord both succeed) but the restaurant's
 * stationScreensEnabled is false. If the flag check were missing, wrong, or ordered after any
 * data access, this is exactly the shape of bug that would leak — so the Supabase mock's
 * `.from()` THROWS unconditionally. A 403 with the throw never firing is the only way every
 * assertion below passes; a route that queries anything first would fail loudly, not silently.
 *
 * NOT COVERED HERE, stated plainly rather than implied: there is no fourth "station-stream"
 * route to test — the earlier SSE relay was deleted when realtime was moved onto the shared
 * subscribeRestaurantOrdersRealtime (see lib/supabase/orders.ts), which subscribes over the
 * BROWSER's own Supabase client, not through any terminal-JWT route this flag gates. That
 * channel's existence is therefore NOT blocked by stationScreensEnabled — only the DATA
 * (station-lines GET) and WRITES (the two bump routes) are. What it can leak with the flag off
 * is bounded to "an order_lines row changed for this restaurant, at this time" — this code never
 * reads `payload.new`, so no row content crosses that channel — and is gated by whatever RLS
 * order_lines itself carries, which this branch does not own. Worth restating to whoever owns
 * that table's RLS, not something fixable from here.
 *
 * Same jest.mock('@/lib/supabase/server', ...) shape __tests__/121-cash-ready-to-pay-
 * route.test.ts already established for testing a route handler directly and hermetically.
 */
import { GET as stationLinesGET } from '@/app/api/terminal/station-lines/route'
import { POST as bumpLinePOST } from '@/app/api/terminal/station-lines/[lineId]/route'
import { POST as bumpRoundPOST } from '@/app/api/terminal/bar-rounds/[roundId]/route'

const TERMINAL_ID = 'terminal-1'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

let fromCallCount = 0

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
  requireFeature: async () => ({ allowed: false }),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      fromCallCount += 1
      throw new Error(`REACHED DATA ACCESS on '${table}' — the flag-off gate did not stop this route before any query`)
    },
    channel() {
      fromCallCount += 1
      throw new Error("REACHED A REALTIME CHANNEL — the flag-off gate did not stop this route before subscribing")
    },
  }),
}))

beforeEach(() => {
  fromCallCount = 0
})

describe('station screens are unreachable with stationScreensEnabled off', () => {
  it('GET /api/terminal/station-lines refuses with 403 and never queries orders or order_lines', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not enabled/i)
    expect(fromCallCount).toBe(0)
  })

  it('POST /api/terminal/station-lines/:lineId (the Cooked/Ready-to-run bump) refuses with 403 and writes nothing', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines/line-1', {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cooked' }),
    })
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId: 'line-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not enabled/i)
    expect(fromCallCount).toBe(0)
  })

  it('POST /api/terminal/bar-rounds/:roundId (the Out bump) refuses with 403 and writes nothing', async () => {
    const req = new Request('http://localhost/api/terminal/bar-rounds/order-1', {
      method: 'POST',
      headers: { authorization: 'Bearer fake' },
    })
    const res = await bumpRoundPOST(req, { params: Promise.resolve({ roundId: 'order-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not enabled/i)
    expect(fromCallCount).toBe(0)
  })
})
