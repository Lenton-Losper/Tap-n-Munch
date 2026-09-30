/**
 * POST /api/terminals/activate -- a device registered to ANOTHER restaurant (device management
 * sprint, 2026-09-30).
 *
 * The refusal stays (F19): a valid code alone never moves a device between venues. What this pins:
 *   - the refusal records WHICH device asked, on the code's own row, so a manager can approve it;
 *   - only an approval by that restaurant, bound to THIS device, lets the next attempt transfer;
 *   - the transfer itself is delegated, whole, to transfer_terminal_device() (whose own behaviour --
 *     locks, release, session invalidation, audit -- is proven by supabase/tests/device-transfer.test.sql);
 *   - every protection that ran before still runs first: code required, code valid, code unexpired.
 *
 * The database function is a spy here. Its job in this suite is to prove WHEN the route calls it
 * and with WHAT, and that the route never binds the device any other way.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'

const VENUE_A = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5' // the device's current home
const VENUE_B = 'b161c758-582d-4dfa-839a-9fa35c492a49' // the restaurant whose code it presents
const OLD_ROW = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const CODE_ROW = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const DEVICE = '6799d4ca39a2c328'
const CODE = 'FT-WBHZ-EJ5Z'
const MANAGER = 'dddddddd-0000-4000-8000-00000000000d'

let mockDb: InMemoryDb
const mockRpc = jest.fn()

jest.mock('@/lib/terminals/terminal-jwt', () => ({
  signTerminalJwt: jest.fn(async (p: { terminal_id: string }) => `token-for-${p.terminal_id}`),
}))
jest.mock('@/lib/terminals/refresh-token', () => ({
  generateRefreshToken: () => 'refresh-token',
  hashRefreshToken: async () => 'refresh-hash',
  refreshTokenExpiresAt: () => '2099-01-01T00:00:00.000Z',
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return { ...real, rpc: (name: string, args: unknown) => mockRpc(name, args) }
  },
}))

import { POST } from '@/app/api/terminals/activate/route'

type Row = Record<string, unknown>

const oldRow = (over: Row = {}): Row => ({
  id: OLD_ROW,
  restaurant_id: VENUE_A,
  device_id: DEVICE,
  device_serial: DEVICE,
  sn: null,
  status: 'active',
  active: true,
  activated_at: '2026-09-29T17:38:05.631Z',
  refresh_token_hash: 'old-refresh-hash',
  refresh_token_expires_at: '2099-01-01T00:00:00.000Z',
  activation_code: null,
  activation_code_expires_at: null,
  ...over,
})

const codeRow = (over: Row = {}): Row => ({
  id: CODE_ROW,
  restaurant_id: VENUE_B,
  device_id: null,
  device_serial: null,
  status: 'pending',
  active: false,
  activation_code: CODE,
  activation_code_expires_at: '2099-01-01T00:00:00.000Z',
  transfer_request_device_id: null,
  transfer_requested_at: null,
  transfer_approved_at: null,
  transfer_approved_by: null,
  ...over,
})

function seed(rows: Row[]) {
  mockDb = new InMemoryDb({
    restaurant_terminals: rows,
    restaurants: [
      { id: VENUE_A, name: 'Digi Cofee', finatic_merchant_no: 'M-A', finatic_store_no: 'S-A' },
      { id: VENUE_B, name: 'FNB ChowNow', finatic_merchant_no: 'M-B', finatic_store_no: 'S-B' },
    ],
    audit_logs: [],
  })
}

function terminal(id: string): Row {
  return mockDb.rows('restaurant_terminals').find((r) => r.id === id) as Row
}

async function activate(body: Row) {
  const res = await POST(
    new Request('https://www.flashtap.app/api/terminals/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  )
  return { status: res.status, body: (await res.json()) as Row }
}

/** What transfer_terminal_device() does, in the shape the route relies on. */
function rpcSucceedsLikeTheDatabase() {
  mockRpc.mockImplementation(async (_name: string, args: Row) => {
    const old = terminal(OLD_ROW)
    Object.assign(old, { device_id: null, device_serial: `ft-${OLD_ROW}`, status: 'revoked', active: false, refresh_token_hash: null })
    Object.assign(terminal(String(args.p_code_terminal_id)), {
      device_id: args.p_device_id,
      device_serial: args.p_device_serial,
      status: 'active',
      active: true,
      activation_code: null,
      refresh_token_hash: args.p_refresh_token_hash,
    })
    return { data: { terminalId: args.p_code_terminal_id, releasedCount: 1 }, error: null }
  })
}

beforeEach(() => {
  mockRpc.mockReset()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('not yet approved: refused, and the request is recorded for this restaurant', () => {
  it('refuses with 409, says what to do, and never calls the transfer', async () => {
    seed([oldRow(), codeRow()])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('DEVICE_REGISTERED_ELSEWHERE')
    expect(res.body.transfer).toBe('approval_required')
    expect(String(res.body.error)).toMatch(/approve/i)
    expect(String(res.body.error)).not.toMatch(/Digi Cofee/)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(res.body.accessToken).toBeUndefined()
  })

  it("records WHICH device asked on its own code row, and leaves the old restaurant's row alone", async () => {
    seed([oldRow(), codeRow()])
    const before = { ...terminal(OLD_ROW) }
    await activate({ code: CODE, device_id: DEVICE })
    expect(terminal(CODE_ROW).transfer_request_device_id).toBe(DEVICE)
    expect(terminal(CODE_ROW).transfer_requested_at).toEqual(expect.any(String))
    expect(terminal(CODE_ROW).transfer_approved_at).toBeNull()
    expect(terminal(CODE_ROW).activation_code).toBe(CODE)
    expect(terminal(OLD_ROW)).toEqual(before)
    const audit = mockDb.rows('audit_logs')
    expect(audit).toEqual([
      expect.objectContaining({ restaurant_id: VENUE_B, action: 'terminal.transfer_requested', entity_id: CODE_ROW }),
    ])
  })

  it('asking again before approval says it is still waiting, and records nothing twice', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: '2026-09-30T10:00:00.000Z' })])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toMatch(/still waiting/i)
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('approved for this device: the next attempt transfers', () => {
  it('delegates the whole move to transfer_terminal_device, with the code row, the device and the NEW session', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: '2026-09-30T10:00:00.000Z', transfer_approved_at: '2026-09-30T10:01:00.000Z', transfer_approved_by: MANAGER })])
    rpcSucceedsLikeTheDatabase()
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('transfer_terminal_device', {
      p_code_terminal_id: CODE_ROW,
      p_device_id: DEVICE,
      p_device_serial: DEVICE,
      p_sn: null,
      p_refresh_token_hash: 'refresh-hash',
      p_refresh_token_expires_at: '2099-01-01T00:00:00.000Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.terminal_id).toBe(CODE_ROW)
    expect(res.body.restaurant_id).toBe(VENUE_B)
    expect(res.body.accessToken).toBe(`token-for-${CODE_ROW}`)
    expect(res.body.refreshToken).toBe('refresh-token')
  })

  it('the route itself writes no terminal row on a transfer -- the database function did it all', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: 'x', transfer_approved_at: 'y' })])
    // A spy that changes NOTHING: any bound identity afterwards would have come from the route.
    mockRpc.mockResolvedValue({ data: { terminalId: CODE_ROW }, error: null })
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(200)
    expect(terminal(CODE_ROW).device_id).toBeNull()
    expect(terminal(OLD_ROW).device_id).toBe(DEVICE)
  })

  it('an approval for a DIFFERENT device does not transfer this one', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: 'some-other-device', transfer_requested_at: 'x', transfer_approved_at: 'y' })])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(409)
    expect(mockRpc).not.toHaveBeenCalled()
    // The new request replaces the old one, and the approval -- which was for the other device -- is dropped.
    expect(terminal(CODE_ROW).transfer_request_device_id).toBe(DEVICE)
    expect(terminal(CODE_ROW).transfer_approved_at).toBeNull()
  })

  it('when the database refuses (approval withdrawn meanwhile), no token is issued', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: 'x', transfer_approved_at: 'y' })])
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TRANSFER_NOT_APPROVED' } })
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(409)
    expect(res.body.accessToken).toBeUndefined()
  })

  it('when the database finds the code expired under its lock, it is the ordinary invalid-code answer', async () => {
    seed([oldRow(), codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: 'x', transfer_approved_at: 'y' })])
    mockRpc.mockResolvedValue({ data: null, error: { message: 'TRANSFER_CODE_INVALID' } })
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid or expired activation code')
    expect(res.body.accessToken).toBeUndefined()
  })

  it('a device held BOTH here and elsewhere is still refused, even with an approval', async () => {
    const sameVenueRow = oldRow({ id: 'cccccccc-3333-4333-8333-cccccccccccc', restaurant_id: VENUE_B, device_id: null, device_serial: DEVICE })
    seed([oldRow(), sameVenueRow, codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: 'x', transfer_approved_at: 'y' })])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(409)
    expect(res.body.transfer).toBe('not_available')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('the code protections still run first', () => {
  const approved = () => codeRow({ transfer_request_device_id: DEVICE, transfer_requested_at: 'x', transfer_approved_at: 'y' })

  it('a missing code is refused (400) and nothing is written or transferred', async () => {
    seed([oldRow(), approved()])
    const res = await activate({ device_id: DEVICE })
    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('a wrong code is refused (400)', async () => {
    seed([oldRow(), approved()])
    const res = await activate({ code: 'FT-NOPE-NOPE', device_id: DEVICE })
    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('an EXPIRED code is refused (400), approval or not', async () => {
    seed([oldRow(), codeRow({ activation_code_expires_at: '2020-01-01T00:00:00.000Z', transfer_request_device_id: DEVICE, transfer_approved_at: 'y' })])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
  })

  it('a code of the WRONG restaurant cannot be used: the approval lives on the code row the device presents', async () => {
    // Venue A's own code, approved for nothing; the device is held by A itself -> ordinary rebind, no transfer.
    seed([oldRow(), codeRow({ restaurant_id: VENUE_A })])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(res.body.terminal_id).toBe(OLD_ROW)
  })
})

describe('an ordinary activation is unchanged', () => {
  it('an unregistered device activates the code row, with no transfer involved', async () => {
    seed([codeRow()])
    const res = await activate({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(200)
    expect(res.body.terminal_id).toBe(CODE_ROW)
    expect(terminal(CODE_ROW).device_id).toBe(DEVICE)
    expect(terminal(CODE_ROW).status).toBe('active')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDb.rows('audit_logs')).toEqual([
      expect.objectContaining({ restaurant_id: VENUE_B, action: 'terminal.activated', entity_id: CODE_ROW }),
    ])
  })
})
