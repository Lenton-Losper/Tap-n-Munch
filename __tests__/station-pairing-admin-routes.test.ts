/**
 * The four manager-facing routes behind Settings -> Payment & terminals' "Pair a screen":
 *   GET  /api/admin/terminals/stations              (list)
 *   POST /api/admin/terminals/stations               (pair / issue a code)
 *   POST /api/admin/terminals/stations/:id/revoke
 *   POST /api/admin/terminals/stations/:id/reissue-code
 *
 * All four are gated on terminal:auth:manage (PERMISSIONS.TERMINAL_AUTH_MANAGE) and, per
 * lib/stations/pairing-copy.ts's docblock, the list route must NEVER return activation_code --
 * the code is shown exactly once, by the POST/reissue response, never by a later GET.
 */
import { GET as listGET, POST as pairPOST } from '@/app/api/admin/terminals/stations/route'
import { POST as revokePOST } from '@/app/api/admin/terminals/stations/[terminalId]/revoke/route'
import { POST as reissuePOST } from '@/app/api/admin/terminals/stations/[terminalId]/reissue-code/route'

const USER_ID = 'user-1'
const RESTAURANT_ID = 'rest-1'

type Row = Record<string, unknown>

let rows: Row[] = []
let permissionDenied = false

function applyFilters(source: Row[], eqs: Array<[string, unknown]>, nots: Array<[string, string, unknown]>) {
  let out = source
  for (const [col, val] of eqs) out = out.filter((r) => String(r[col] ?? '') === String(val))
  for (const [col, op, val] of nots) {
    if (op === 'is' && val === null) out = out.filter((r) => r[col] != null)
  }
  return out
}

function makeQuery(table: string) {
  if (table !== 'restaurant_terminals') throw new Error(`unexpected table ${table}`)

  const eqs: Array<[string, unknown]> = []
  const nots: Array<[string, string, unknown]> = []
  let insertedRow: Row | null = null
  let updatePatch: Row | null = null

  const builder: any = {
    select() {
      return builder
    },
    eq(col: string, val: unknown) {
      eqs.push([col, val])
      return builder
    },
    not(col: string, op: string, val: unknown) {
      nots.push([col, op, val])
      return builder
    },
    order() {
      return builder
    },
    insert(row: Row) {
      insertedRow = { id: `new-${rows.length + 1}`, created_at: new Date().toISOString(), ...row }
      return builder
    },
    update(patch: Row) {
      updatePatch = patch
      return builder
    },
    async single() {
      if (insertedRow) {
        rows.push(insertedRow)
        return { data: insertedRow, error: null }
      }
      return { data: null, error: { message: 'no row' } }
    },
    async maybeSingle() {
      const found = applyFilters(rows, eqs, nots)[0] ?? null
      return { data: found, error: null }
    },
    then(onFulfilled: (r: { data: Row[]; error: null }) => unknown) {
      if (updatePatch) {
        const targets = applyFilters(rows, eqs, [])
        for (const t of targets) Object.assign(t, updatePatch)
        return Promise.resolve(onFulfilled({ data: targets, error: null }))
      }
      return Promise.resolve(onFulfilled({ data: applyFilters(rows, eqs, nots), error: null }))
    },
  }
  return builder
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({ from: (table: string) => makeQuery(table) }),
}))

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: USER_ID }),
  getRestaurantIdForUser: async () => RESTAURANT_ID,
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () =>
    permissionDenied
      ? new Response(JSON.stringify({ error: 'denied' }), { status: 403 }) as unknown as null
      : null,
}))

jest.mock('@/lib/terminals/activation-code', () => ({
  generateTerminalActivationCode: () => 'FT-TEST-CODE',
}))

beforeEach(() => {
  rows = []
  permissionDenied = false
})

function req(method: string, body?: unknown) {
  return new Request('http://localhost/api/admin/terminals/stations', {
    method,
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer fake' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

describe('permission gate: terminal:auth:manage', () => {
  beforeEach(() => {
    permissionDenied = true
  })

  it('GET (list) refuses without the permission', async () => {
    const res = await listGET(req('GET'))
    expect(res.status).toBe(403)
  })

  it('POST (pair) refuses without the permission and creates nothing', async () => {
    const res = await pairPOST(req('POST', { station: 'kitchen' }))
    expect(res.status).toBe(403)
    expect(rows).toHaveLength(0)
  })

  it('revoke refuses without the permission', async () => {
    const res = await revokePOST(req('POST'), { params: Promise.resolve({ terminalId: 'x' }) })
    expect(res.status).toBe(403)
  })

  it('reissue-code refuses without the permission', async () => {
    const res = await reissuePOST(req('POST'), { params: Promise.resolve({ terminalId: 'x' }) })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/terminals/stations — pairing a screen', () => {
  it('rejects an invalid station', async () => {
    const res = await pairPOST(req('POST', { station: 'grill' }))
    expect(res.status).toBe(400)
  })

  it('creates a row with the chosen station, default name, and returns the code exactly once', async () => {
    const res = await pairPOST(req('POST', { station: 'kitchen' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.station).toBe('kitchen')
    expect(body.name).toBe('Kitchen Screen')
    expect(body.activationCode).toBe('FT-TEST-CODE')
    expect(typeof body.expiresAt).toBe('string')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      restaurant_id: RESTAURANT_ID,
      station_kind: 'kitchen',
      status: 'pending',
      active: false,
      activation_code: 'FT-TEST-CODE',
    })
  })

  it('honors a custom name instead of the default', async () => {
    const res = await pairPOST(req('POST', { station: 'bar', name: 'Upstairs Bar' }))
    const body = await res.json()
    expect(body.name).toBe('Upstairs Bar')
  })
})

describe('GET /api/admin/terminals/stations — list never carries the code', () => {
  beforeEach(async () => {
    await pairPOST(req('POST', { station: 'kitchen' }))
  })

  it('lists the paired screen without activation_code', async () => {
    const res = await listGET(req('GET'))
    const body = await res.json()
    expect(body.screens).toHaveLength(1)
    expect(body.screens[0]).not.toHaveProperty('activation_code')
    expect(body.screens[0]).not.toHaveProperty('activationCode')
    expect(body.screens[0].station).toBe('kitchen')
    expect(body.screens[0].hasPendingCode).toBe(true)
  })

  it('excludes P5 / waiter terminals (station_kind null)', async () => {
    rows.push({
      id: 'p5-1',
      restaurant_id: RESTAURANT_ID,
      terminal_name: 'P5',
      station_kind: null,
      status: 'active',
      created_at: new Date().toISOString(),
    })
    const res = await listGET(req('GET'))
    const body = await res.json()
    expect(body.screens.map((s: { id: string }) => s.id)).not.toContain('p5-1')
  })
})

describe('POST /api/admin/terminals/stations/:id/revoke', () => {
  it('sets status revoked, active false, and clears the code and refresh token', async () => {
    const paired = await pairPOST(req('POST', { station: 'bar' })).then((r) => r.json())
    const res = await revokePOST(req('POST'), { params: Promise.resolve({ terminalId: paired.id }) })
    expect(res.status).toBe(200)

    const row = rows.find((r) => r.id === paired.id)!
    expect(row.status).toBe('revoked')
    expect(row.active).toBe(false)
    expect(row.activation_code).toBeNull()
    expect(row.activation_code_expires_at).toBeNull()
    expect(row.refresh_token_hash).toBeNull()
  })

  it('404s for a terminal id that is not a paired station screen', async () => {
    rows.push({ id: 'p5-1', restaurant_id: RESTAURANT_ID, station_kind: null })
    const res = await revokePOST(req('POST'), { params: Promise.resolve({ terminalId: 'p5-1' }) })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/terminals/stations/:id/reissue-code', () => {
  it('generates a fresh code, flips the row back to pending/inactive, and clears the refresh token', async () => {
    const paired = await pairPOST(req('POST', { station: 'kitchen' })).then((r) => r.json())
    // Simulate the row having activated since.
    Object.assign(rows.find((r) => r.id === paired.id)!, {
      status: 'active',
      active: true,
      refresh_token_hash: 'old-hash',
    })

    const res = await reissuePOST(req('POST'), { params: Promise.resolve({ terminalId: paired.id }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activationCode).toBe('FT-TEST-CODE')
    expect(body.station).toBe('kitchen')

    const row = rows.find((r) => r.id === paired.id)!
    expect(row.status).toBe('pending')
    expect(row.active).toBe(false)
    expect(row.refresh_token_hash).toBeNull()
    expect(row.activation_code).toBe('FT-TEST-CODE')
  })

  it('keeps the same terminal id and name -- history is not orphaned by reissuing', async () => {
    const paired = await pairPOST(req('POST', { station: 'bar', name: 'Downstairs Bar' })).then((r) => r.json())
    const res = await reissuePOST(req('POST'), { params: Promise.resolve({ terminalId: paired.id }) })
    const body = await res.json()
    expect(body.id).toBe(paired.id)
    expect(body.name).toBe('Downstairs Bar')
    expect(rows).toHaveLength(1)
  })
})
