/**
 * The three station-serving routes refuse a terminal that is paired to the OTHER screen (or not
 * paired at all), even with a valid terminal JWT and the flag on. Same shape as
 * station-screens-flag-off-unreachable.test.ts, one gate over: that file proves the flag stops
 * an unauthorized restaurant; this one proves pairing stops an authorized restaurant's OWN
 * terminal from reaching the wrong screen with it.
 */
import { GET as stationLinesGET } from '@/app/api/terminal/station-lines/route'
import { POST as bumpLinePOST } from '@/app/api/terminal/station-lines/[lineId]/route'
import { POST as bumpRoundPOST } from '@/app/api/terminal/bar-rounds/[roundId]/route'

const TERMINAL_ID = 'terminal-pairing-1'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

let terminalStationKind: string | null = 'bar' // paired to BAR throughout this file

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

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
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
      throw new Error(`REACHED DATA ACCESS on '${table}' — the pairing gate did not stop this route`)
    },
  }),
}))

beforeEach(() => {
  terminalStationKind = 'bar'
})

describe('a bar-paired terminal cannot reach the kitchen screen', () => {
  it('GET /api/terminal/station-lines?station=kitchen refuses with 403 STATION_NOT_PAIRED and reads pairedTo', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines?station=kitchen', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_NOT_PAIRED')
    expect(body.pairedTo).toBe('bar')
  })

  it('POST /api/terminal/station-lines/:lineId (the kitchen bump) refuses with 403 and never reaches order_lines', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines/line-1', {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cooked' }),
    })
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId: 'line-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_NOT_PAIRED')
  })

  it('correctly reaches the kitchen board when actually paired to kitchen', async () => {
    terminalStationKind = 'kitchen'
    const req = new Request('http://localhost/api/terminal/station-lines?station=kitchen', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    // Passes the pairing gate and proceeds to the (unmocked-further) orders read, which throws
    // in this stub — 403 with STATION_NOT_PAIRED would be the wrong-shaped failure; anything
    // else confirms the gate let it through.
    const body = await res.json()
    expect(body.code).not.toBe('STATION_NOT_PAIRED')
  })
})

describe('a kitchen-paired terminal cannot reach the bar screen', () => {
  beforeEach(() => {
    terminalStationKind = 'kitchen'
  })

  it('GET /api/terminal/station-lines?station=bar refuses with 403 STATION_NOT_PAIRED', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines?station=bar', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_NOT_PAIRED')
    expect(body.pairedTo).toBe('kitchen')
  })

  it('POST /api/terminal/bar-rounds/:roundId (the Out bump) refuses with 403', async () => {
    const req = new Request('http://localhost/api/terminal/bar-rounds/order-1', {
      method: 'POST',
      headers: { authorization: 'Bearer fake' },
    })
    const res = await bumpRoundPOST(req, { params: Promise.resolve({ roundId: 'order-1' }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_NOT_PAIRED')
  })
})

describe('an unpaired terminal (station_kind null) reaches neither screen', () => {
  beforeEach(() => {
    terminalStationKind = null
  })

  it('refuses kitchen', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines?station=kitchen', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(403)
    expect((await res.json()).pairedTo).toBeNull()
  })

  it('refuses bar', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines?station=bar', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(403)
    expect((await res.json()).pairedTo).toBeNull()
  })
})

describe('an invalid ?station= is rejected before the pairing check ever runs', () => {
  it('400s on a missing station param', async () => {
    const req = new Request('http://localhost/api/terminal/station-lines', {
      headers: { authorization: 'Bearer fake' },
    })
    const res = await stationLinesGET(req)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_STATION')
  })
})
