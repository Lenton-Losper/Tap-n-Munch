/**
 * /api/admin/devices -- the Devices console's lifecycle routes (device management sprint, 2026-09-30).
 *
 * Pinned here, through the REAL routes over the in-memory PostgREST fake:
 *   A rename, B deactivate, C a deactivated terminal cannot operate, D remove, E remove releases the
 *   identity, F remove ends the session, G payment history untouched, H reactivate, cancel code,
 *   approve transfer; every action is audited; a user of Restaurant A cannot read, change, remove or
 *   approve anything of Restaurant B by changing a UUID; permissions are checked per device kind.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'

const VENUE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const VENUE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const USER_A = 'user-of-a'
const P5_A = 'a0000000-0000-4000-8000-00000000000a'
const P5_B = 'b0000000-0000-4000-8000-00000000000b'
const KITCHEN_A = 'a0000000-0000-4000-8000-0000000000c1'
const BAR_A = 'a0000000-0000-4000-8000-0000000000c2'
const CODE_A = 'a0000000-0000-4000-8000-0000000000d1'
const FUTURE = '2099-01-01T00:00:00.000Z'

let mockDb: InMemoryDb
let mockPermissions: Record<string, boolean> = {}

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => mockDb.client() }))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async (req: Request) => {
    if (!req.headers.get('authorization')) throw new Error('Missing authorization. Sign in again.')
    return { id: 'user-of-a' }
  },
  // The caller's restaurant comes from THEIR session -- always Venue A here, whatever the request says.
  getRestaurantIdForUser: async () => 'aaaaaaaa-0000-4000-8000-000000000001',
}))
jest.mock('@/lib/permissions/authorize', () => ({
  authorize: async (_u: string, _r: string, permission: string) => Boolean(mockPermissions[permission]),
}))
jest.mock('@/lib/onboarding/setup-status-server', () => ({ markSetupStepComplete: async () => undefined }))
// lib/terminal-auth imports jose, which is ESM-only and cannot load under ts-jest. The check under
// test (validateTerminalRecord) never touches it, so the three imports are stubbed out.
jest.mock('jose', () => ({ jwtVerify: jest.fn(), decodeProtectedHeader: jest.fn(), importJWK: jest.fn() }))

import { GET as listGET, POST as createPOST } from '@/app/api/admin/devices/route'
import { PATCH, DELETE } from '@/app/api/admin/devices/[deviceId]/route'
import { GET as activityGET } from '@/app/api/admin/devices/[deviceId]/activity/route'

type Row = Record<string, unknown>

const p5 = (over: Row = {}): Row => ({
  id: P5_A,
  restaurant_id: VENUE_A,
  station_kind: null,
  status: 'active',
  active: true,
  terminal_name: 'New Terminal',
  sn: 'WPHK002502002822',
  device_id: 'b68914779e542823',
  device_serial: 'b68914779e542823',
  app_version: '2.42',
  activated_at: '2026-09-30T07:44:08.000Z',
  last_seen_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  refresh_token_hash: 'live-refresh',
  refresh_token_expires_at: FUTURE,
  activation_code: null,
  activation_code_expires_at: null,
  ...over,
})

function seed(extra: Row[] = []) {
  mockDb = new InMemoryDb({
    restaurant_terminals: [
      p5(),
      p5({ id: P5_B, restaurant_id: VENUE_B, device_id: 'dev-b', device_serial: 'dev-b', sn: null, terminal_name: 'B till' }),
      p5({ id: KITCHEN_A, station_kind: 'kitchen', terminal_name: 'Kitchen Screen', device_id: null, device_serial: `ft-${KITCHEN_A}`, sn: null }),
      p5({ id: BAR_A, station_kind: 'bar', terminal_name: 'Bar Screen', device_id: null, device_serial: `ft-${BAR_A}`, sn: null }),
      {
        id: CODE_A,
        restaurant_id: VENUE_A,
        station_kind: null,
        status: 'pending',
        active: false,
        terminal_name: 'New Terminal',
        activation_code: 'FT-ABCD-WXYZ',
        activation_code_expires_at: FUTURE,
        device_id: null,
        device_serial: null,
        activated_at: null,
      },
      ...extra,
    ],
    audit_logs: [],
    payment_events: [
      { id: 'pe-1', restaurant_id: VENUE_A, terminal_id: P5_A, event_type: 'sale', amount: 34, created_at: new Date(Date.now() - 3600_000).toISOString() },
    ],
    terminal_payment_intents: [
      { id: 'tpi-1', restaurant_id: VENUE_A, terminal_id: P5_A, status: 'confirmed', amount_cents: 3400 },
    ],
  })
}

const AUTH = { authorization: 'Bearer user-token' }
const params = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) })
const req = (method: string, body?: unknown, headers: Record<string, string> = AUTH) =>
  new Request('http://localhost/api/admin/devices', {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function patch(deviceId: string, body: Row) {
  const res = await PATCH(req('PATCH', body), params(deviceId))
  return { status: res.status, body: (await res.json()) as Row }
}
async function remove(deviceId: string) {
  const res = await DELETE(req('DELETE'), params(deviceId))
  return { status: res.status, body: (await res.json()) as Row }
}
const row = (id: string) => mockDb.rows('restaurant_terminals').find((r) => r.id === id) as Row | undefined
const auditFor = (id: string) => mockDb.rows('audit_logs').filter((a) => a.entity_id === id)

beforeEach(() => {
  mockPermissions = { 'payments:configure': true, 'terminal:auth:manage': true }
  seed()
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('listing', () => {
  it("returns this restaurant's devices only, with what an admin needs and nothing secret", async () => {
    const res = await listGET(req('GET'))
    const body = (await res.json()) as { devices: Row[] }
    expect(res.status).toBe(200)
    const ids = body.devices.map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining([P5_A, KITCHEN_A, BAR_A, CODE_A]))
    expect(ids).not.toContain(P5_B)
    const till = body.devices.find((d) => d.id === P5_A)!
    expect(till).toMatchObject({
      kind: 'payment',
      name: 'Payment terminal WPHK002502002822',
      model: 'Wiseasy terminal',
      serial: 'WPHK002502002822',
      appVersion: '2.42',
      lifecycle: 'online',
      lastSaleAt: expect.any(String),
    })
    const code = body.devices.find((d) => d.id === CODE_A)!
    expect(code.lifecycle).toBe('pending')
    expect(code.codeHint).toBe('WXYZ')
    const text = JSON.stringify(body)
    expect(text).not.toContain('FT-ABCD-WXYZ')
    expect(text).not.toContain('live-refresh')
  })

  it('a user who may manage only screens sees only screens', async () => {
    mockPermissions = { 'terminal:auth:manage': true }
    const body = (await (await listGET(req('GET'))).json()) as { devices: Row[] }
    expect(body.devices.map((d) => d.kind).sort()).toEqual(['bar', 'kitchen'])
  })

  it('no device permission at all is refused', async () => {
    mockPermissions = {}
    expect((await listGET(req('GET'))).status).toBe(403)
  })

  it('an unauthenticated caller is refused', async () => {
    expect((await listGET(req('GET', undefined, {}))).status).toBe(401)
  })
})

describe('A. rename', () => {
  it('renames, and records who did it', async () => {
    const res = await patch(P5_A, { action: 'rename', name: '  Kitchen P5  ' })
    expect(res.status).toBe(200)
    expect(row(P5_A)!.terminal_name).toBe('Kitchen P5')
    expect(auditFor(P5_A)).toEqual([expect.objectContaining({ restaurant_id: VENUE_A, action: 'terminal.renamed' })])
    expect((auditFor(P5_A)[0].metadata as Row).by).toBe(USER_A)
  })

  it('refuses an empty or over-long name', async () => {
    expect((await patch(P5_A, { action: 'rename', name: '   ' })).status).toBe(400)
    expect((await patch(P5_A, { action: 'rename', name: 'x'.repeat(61) })).status).toBe(400)
    expect(auditFor(P5_A)).toHaveLength(0)
  })
})

describe('B/C/H. deactivate and reactivate', () => {
  it('deactivates: status inactive (what every terminal route refuses), identity and session KEPT', async () => {
    const res = await patch(P5_A, { action: 'deactivate' })
    expect(res.status).toBe(200)
    expect(row(P5_A)).toMatchObject({ status: 'inactive', device_id: 'b68914779e542823', refresh_token_hash: 'live-refresh' })
    expect(auditFor(P5_A).map((a) => a.action)).toEqual(['terminal.deactivated'])
  })

  it('touches ONLY the named device: every other device of the restaurant is exactly as it was', async () => {
    // Caught by mutation DM-4: an UPDATE that lost its id filter deactivated the whole venue.
    const others = [KITCHEN_A, BAR_A, CODE_A].map((id) => ({ ...row(id)! }))
    await patch(P5_A, { action: 'deactivate' })
    await patch(P5_A, { action: 'rename', name: 'Front till' })
    await patch(KITCHEN_A, { action: 'revoke' })
    expect(row(BAR_A)).toEqual(others[1])
    expect(row(CODE_A)).toEqual(others[2])
    expect(row(KITCHEN_A)!.terminal_name).toBe('Kitchen Screen')
    expect(row(P5_A)!.status).toBe('inactive')
  })

  it('a disconnected (revoked) device cannot be "deactivated" -- there is nothing left to switch off', async () => {
    // Caught by mutation DM-16.
    await patch(KITCHEN_A, { action: 'revoke' })
    const res = await patch(KITCHEN_A, { action: 'deactivate' })
    expect(res.status).toBe(409)
    expect(row(KITCHEN_A)!.status).toBe('revoked')
  })

  it('C. validateTerminalRecord refuses a deactivated terminal', async () => {
    await patch(P5_A, { action: 'deactivate' })
    const { validateTerminalRecord } = jest.requireActual('@/lib/terminal-auth') as typeof import('@/lib/terminal-auth')
    await expect(
      validateTerminalRecord(mockDb.client(), { terminalId: P5_A, restaurantId: VENUE_A }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('H. reactivates a deactivated terminal', async () => {
    await patch(P5_A, { action: 'deactivate' })
    const res = await patch(P5_A, { action: 'reactivate' })
    expect(res.status).toBe(200)
    expect(row(P5_A)!.status).toBe('active')
  })

  it('refuses to reactivate a terminal that is not deactivated', async () => {
    expect((await patch(P5_A, { action: 'reactivate' })).status).toBe(409)
  })
})

describe('D/E/F/G. remove', () => {
  it('removes the registration: identity released, session gone, audited with the released identity', async () => {
    const res = await remove(P5_A)
    expect(res.status).toBe(200)
    expect(row(P5_A)).toBeUndefined()
    const holders = mockDb.rows('restaurant_terminals').filter((r) => r.device_id === 'b68914779e542823' || r.device_serial === 'b68914779e542823')
    expect(holders).toHaveLength(0)
    expect(mockDb.rows('restaurant_terminals').some((r) => r.refresh_token_hash === 'live-refresh' && r.restaurant_id === VENUE_A && r.id === P5_A)).toBe(false)
    expect(auditFor(P5_A)).toEqual([
      expect.objectContaining({
        restaurant_id: VENUE_A,
        action: 'terminal.removed',
        metadata: expect.objectContaining({ releasedDeviceId: 'b68914779e542823', by: USER_A }),
      }),
    ])
  })

  it('G. payment history is untouched', async () => {
    await remove(P5_A)
    expect(mockDb.rows('payment_events')).toHaveLength(1)
    expect(mockDb.rows('terminal_payment_intents')).toEqual([
      expect.objectContaining({ terminal_id: P5_A, status: 'confirmed', amount_cents: 3400 }),
    ])
  })

  it('an unused code is CANCELLED (deleted) rather than "removed"', async () => {
    const res = await remove(CODE_A)
    expect(res.status).toBe(200)
    expect(row(CODE_A)).toBeUndefined()
    expect(auditFor(CODE_A).map((a) => a.action)).toEqual(['terminal.activation_code_cancelled'])
  })
})

describe('screens', () => {
  it('R. a kitchen screen can be disconnected (revoked): signed out, code cleared, row kept', async () => {
    const res = await patch(KITCHEN_A, { action: 'revoke' })
    expect(res.status).toBe(200)
    expect(row(KITCHEN_A)).toMatchObject({ status: 'revoked', active: false, refresh_token_hash: null })
  })

  it('S. a bar screen can be unpaired (removed)', async () => {
    expect((await remove(BAR_A)).status).toBe(200)
    expect(row(BAR_A)).toBeUndefined()
  })

  it('revoke is not an action for a payment terminal', async () => {
    expect((await patch(P5_A, { action: 'revoke' })).status).toBe(409)
    expect(row(P5_A)!.status).toBe('active')
  })
})

describe('permissions are checked per device kind', () => {
  it('a screens-only manager cannot touch a payment terminal', async () => {
    mockPermissions = { 'terminal:auth:manage': true }
    expect((await remove(P5_A)).status).toBe(403)
    expect((await patch(P5_A, { action: 'deactivate' })).status).toBe(403)
    expect(row(P5_A)!.status).toBe('active')
  })

  it('a payments-only manager cannot touch a kitchen screen', async () => {
    mockPermissions = { 'payments:configure': true }
    expect((await remove(KITCHEN_A)).status).toBe(403)
    expect(row(KITCHEN_A)).toBeDefined()
  })

  it('cannot issue a code for a kind it may not manage', async () => {
    mockPermissions = { 'terminal:auth:manage': true }
    const res = await createPOST(req('POST', { kind: 'payment' }))
    expect(res.status).toBe(403)
  })
})

describe("cross-restaurant: Restaurant A's user cannot reach Restaurant B's device by its UUID", () => {
  it.each([
    ['rename', () => patch(P5_B, { action: 'rename', name: 'mine now' })],
    ['deactivate', () => patch(P5_B, { action: 'deactivate' })],
    ['approve_transfer', () => patch(P5_B, { action: 'approve_transfer' })],
    ['remove', () => remove(P5_B)],
  ])('%s -> 404, and B’s device is exactly as it was', async (_label, act) => {
    const before = { ...row(P5_B)! }
    const res = await act()
    expect(res.status).toBe(404)
    expect(row(P5_B)).toEqual(before)
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
  })

  it("activity of B's device is not readable", async () => {
    const res = await activityGET(req('GET'), params(P5_B))
    expect(res.status).toBe(404)
  })
})

describe('transfer approval', () => {
  const requested = () => ({
    id: 'a0000000-0000-4000-8000-0000000000e1',
    restaurant_id: VENUE_A,
    station_kind: null,
    status: 'pending',
    active: false,
    terminal_name: 'New Terminal',
    activation_code: 'FT-TRAN-SFER',
    activation_code_expires_at: FUTURE,
    device_id: null,
    activated_at: null,
    transfer_request_device_id: '6799d4ca39a2c328',
    transfer_requested_at: new Date().toISOString(),
    transfer_approved_at: null,
  })

  it('records the approval with who gave it, and audits it', async () => {
    seed([requested()])
    const res = await patch('a0000000-0000-4000-8000-0000000000e1', { action: 'approve_transfer' })
    expect(res.status).toBe(200)
    expect(row('a0000000-0000-4000-8000-0000000000e1')).toMatchObject({
      transfer_approved_by: USER_A,
      transfer_approved_at: expect.any(String),
    })
    expect(auditFor('a0000000-0000-4000-8000-0000000000e1').map((a) => a.action)).toEqual(['terminal.transfer_approved'])
  })

  it('there is nothing to approve on a code no device has asked about', async () => {
    const res = await patch(CODE_A, { action: 'approve_transfer' })
    expect(res.status).toBe(409)
    expect(row(CODE_A)!.transfer_approved_at).toBeUndefined()
  })
})

describe('issuing a code', () => {
  it('returns the full code exactly once, audits it, and the list never shows it again', async () => {
    const res = await createPOST(req('POST', { kind: 'kitchen', name: 'Pass' }))
    const body = (await res.json()) as Row
    expect(res.status).toBe(200)
    expect(String(body.activationCode)).toMatch(/^FT-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const created = row(String(body.id))!
    expect(created).toMatchObject({ restaurant_id: VENUE_A, station_kind: 'kitchen', status: 'pending', terminal_name: 'Pass' })
    expect(auditFor(String(body.id)).map((a) => a.action)).toEqual(['terminal.activation_code_issued'])
    const listed = JSON.stringify(await (await listGET(req('GET'))).json())
    expect(listed).not.toContain(String(body.activationCode))
  })
})

describe('activity', () => {
  it("shows the device's history in words, newest first", async () => {
    await patch(P5_A, { action: 'rename', name: 'Front till' })
    await patch(P5_A, { action: 'deactivate' })
    const res = await activityGET(req('GET'), params(P5_A))
    const body = (await res.json()) as { events: Row[] }
    expect(res.status).toBe(200)
    expect(body.events.map((e) => e.description)).toEqual(expect.arrayContaining(['Renamed', 'Deactivated']))
  })
})

/**
 * LIFECYCLE SEMANTICS, against devices that hold a REAL physical identity (2026-10-01).
 *
 * The screen fixtures above hold no identity (device_id null, placeholder ft-<uuid> serial), so a
 * revoke that wiped the identity would leave them looking exactly the same -- the revoke test could
 * not see that regression. These rows carry a real device_id, device_serial and sn.
 *
 *   deactivate  keeps the registration AND the identity; the device cannot operate
 *   revoke      (screens) ends the session; keeps the registration AND the identity
 *   remove      deletes the registration, releasing the identity
 *
 * Order/payment history is byte-identical after every one of them.
 */
describe('lifecycle semantics with a real device identity', () => {
  const SCREEN_WITH_IDENTITY = 'c4c4c4c4-0000-4000-8000-0000000000c4'
  const screenWithIdentity = () =>
    p5({
      id: SCREEN_WITH_IDENTITY,
      station_kind: 'kitchen',
      terminal_name: 'Pass screen',
      device_id: 'kds-android-7f3a',
      device_serial: 'kds-android-7f3a',
      sn: 'KDS-SN-0001',
    })
  const identityOf = (id: string) => {
    const r = row(id)
    return r ? { device_id: r.device_id, device_serial: r.device_serial, sn: r.sn } : null
  }
  const history = () => JSON.stringify([mockDb.rows('payment_events'), mockDb.rows('terminal_payment_intents')])

  beforeEach(() => seed([screenWithIdentity()]))

  it('REVOKE keeps the physical identity (it is NOT released): signed out, row kept, identity unchanged', async () => {
    const before = identityOf(SCREEN_WITH_IDENTITY)
    const historyBefore = history()
    const res = await patch(SCREEN_WITH_IDENTITY, { action: 'revoke' })
    expect(res.status).toBe(200)
    expect(row(SCREEN_WITH_IDENTITY)).toMatchObject({ status: 'revoked', active: false, refresh_token_hash: null })
    expect(identityOf(SCREEN_WITH_IDENTITY)).toEqual(before)
    expect(before).toEqual({ device_id: 'kds-android-7f3a', device_serial: 'kds-android-7f3a', sn: 'KDS-SN-0001' })
    expect(history()).toBe(historyBefore)
    expect(auditFor(SCREEN_WITH_IDENTITY).map((a) => a.action)).toEqual(['terminal.revoked'])
  })

  it('DEACTIVATE keeps the identity and the session; the device cannot operate (status inactive)', async () => {
    const before = identityOf(P5_A)
    const historyBefore = history()
    expect((await patch(P5_A, { action: 'deactivate' })).status).toBe(200)
    expect(row(P5_A)).toMatchObject({ status: 'inactive', refresh_token_hash: 'live-refresh' })
    expect(identityOf(P5_A)).toEqual(before)
    expect(history()).toBe(historyBefore)
  })

  it('REMOVE releases the identity (the registration is gone) and leaves history untouched', async () => {
    const historyBefore = history()
    expect((await remove(SCREEN_WITH_IDENTITY)).status).toBe(200)
    expect(row(SCREEN_WITH_IDENTITY)).toBeUndefined()
    expect(
      mockDb.rows('restaurant_terminals').some((r) => r.device_id === 'kds-android-7f3a' || r.device_serial === 'kds-android-7f3a'),
    ).toBe(false)
    expect(history()).toBe(historyBefore)
    const removed = auditFor(SCREEN_WITH_IDENTITY).find((a) => a.action === 'terminal.removed')
    expect((removed?.metadata as Row)?.releasedDeviceId).toBe('kds-android-7f3a')
  })

  it('the three stay three: revoke is refused on a payment terminal, whose "stop it" is deactivate', async () => {
    expect((await patch(P5_A, { action: 'revoke' })).status).toBe(409)
    expect(row(P5_A)).toMatchObject({ status: 'active', device_id: 'b68914779e542823' })
  })
})
