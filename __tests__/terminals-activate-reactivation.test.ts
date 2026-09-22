/**
 * POST /api/terminals/activate — reinstall, rebinding, and the errors a reader can act on.
 *
 * ==================================================================================================
 * THE FAILURE THIS SUITE EXISTS FOR
 * ==================================================================================================
 *
 * A P5 activated on 2.38, taking `device_id = <its ANDROID_ID>` onto terminal row A. Reinstalling
 * 2.39 wiped the stored token, so the app asked to activate again — but ANDROID_ID survives
 * reinstall (it is keyed to the signing key). Pointed at a row minted by `generate-code`, the route
 * tried to write that identity onto row B and Postgres refused: 23505 on
 * `restaurant_terminals_device_id_unique`. The device could never activate again, and the reader was
 * told only "Failed to activate terminal".
 *
 * Both halves are pinned here: the rebinding, and the fact that no refusal is allowed to collapse
 * into that generic message again.
 */
import { POST } from '@/app/api/terminals/activate/route'

const VENUE_A = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'
const VENUE_B = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWN_ROW = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const PENDING_ROW = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const DEVICE = 'deb54efd75a504c9'
const CODE = 'FT-2GB8-9FB7'

type Row = Record<string, unknown>

let terminals: Row[] = []
let updates: Array<{ id: unknown; patch: Row }> = []
let updateError: Row | null = null

jest.mock('@/lib/terminals/terminal-jwt', () => ({
  signTerminalJwt: jest.fn(async (p: { terminal_id: string }) => `token-for-${p.terminal_id}`),
}))

jest.mock('@/lib/terminals/refresh-token', () => ({
  generateRefreshToken: () => 'refresh-token',
  hashRefreshToken: async () => 'refresh-hash',
  refreshTokenExpiresAt: () => '2099-01-01T00:00:00.000Z',
}))

/**
 * A table-aware stand-in that honours the filters this route actually uses: `.eq()` on the code
 * lookup, `.in()` on the two identity reads, and `.gt()` on the expiry. A fake that ignored them
 * would answer every question the same way and prove nothing about the branch under test.
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state = { table, op: 'select', patch: null as Row | null, eq: {} as Row, inList: null as { col: string; vals: unknown[] } | null, gt: {} as Row }
      const rows = () =>
        terminals.filter((r) => {
          for (const [k, v] of Object.entries(state.eq)) if (r[k] !== v) return false
          for (const [k, v] of Object.entries(state.gt)) {
            if (r[k] == null) return false
            if (new Date(String(r[k])).getTime() <= new Date(String(v)).getTime()) return false
          }
          if (state.inList && !state.inList.vals.includes(r[state.inList.col])) return false
          return true
        })
      const b: Record<string, unknown> = {}
      const settle = () => {
        if (state.table !== 'restaurant_terminals') return { data: [], error: null }
        if (state.op === 'update') {
          const matched = rows()
          if (updateError) return { data: null, error: updateError }
          for (const r of matched) {
            updates.push({ id: r.id, patch: state.patch ?? {} })
            Object.assign(r, state.patch)
          }
          return { data: matched, error: null }
        }
        return { data: rows(), error: null }
      }
      Object.assign(b, {
        select: () => b,
        update: (patch: Row) => {
          state.op = 'update'
          state.patch = patch
          return b
        },
        eq: (col: string, val: unknown) => {
          state.eq[col] = val
          return b
        },
        gt: (col: string, val: unknown) => {
          state.gt[col] = val
          return b
        },
        in: (col: string, vals: unknown[]) => {
          state.inList = { col, vals }
          return b
        },
        maybeSingle: async () => {
          const r = settle()
          const list = (r.data ?? []) as Row[]
          return { data: list[0] ?? null, error: r.error }
        },
        single: async () => {
          const r = settle()
          const list = (r.data ?? []) as Row[]
          if (state.table === 'restaurants') return { data: { name: 'Digi Cofee', finatic_merchant_no: 'M1', finatic_store_no: 'S1' }, error: null }
          if (r.error) return { data: null, error: r.error }
          return { data: list[0] ?? null, error: list.length ? null : { message: 'not found' } }
        },
        then: (resolve: (v: unknown) => unknown) => resolve(settle()),
      })
      return b
    },
  }),
}))

const pendingRow = (over: Row = {}): Row => ({
  id: PENDING_ROW,
  restaurant_id: VENUE_A,
  device_id: null,
  device_serial: null,
  sn: null,
  name: null,
  active: false,
  status: 'pending',
  activation_code: CODE,
  activation_code_expires_at: '2099-01-01T00:00:00.000Z',
  ...over,
})

const ownedRow = (over: Row = {}): Row => ({
  id: OWN_ROW,
  restaurant_id: VENUE_A,
  device_id: DEVICE,
  device_serial: DEVICE,
  sn: null,
  name: null,
  active: true,
  status: 'active',
  activation_code: null,
  activation_code_expires_at: null,
  ...over,
})

function call(body: unknown) {
  return POST(
    new Request('https://www.flashtap.app/api/terminals/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  )
}

beforeEach(() => {
  terminals = []
  updates = []
  updateError = null
})

describe('first activation of a NEW device', () => {
  it('activates the row the code named and issues a token for it', async () => {
    terminals = [pendingRow()]
    const res = await call({ code: CODE, device_id: 'a-brand-new-device' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.terminal_id).toBe(PENDING_ROW)
    expect(body.accessToken).toBe(`token-for-${PENDING_ROW}`)
    expect(body.restaurant_id).toBe(VENUE_A)
  })

  it('consumes the activation code', async () => {
    terminals = [pendingRow()]
    await call({ code: CODE, device_id: 'a-brand-new-device' })
    const row = terminals.find((r) => r.id === PENDING_ROW)!
    expect(row.activation_code).toBeNull()
    expect(row.active).toBe(true)
    expect(row.status).toBe('active')
  })
})

describe('reinstall: the SAME device, the SAME restaurant', () => {
  it('rebinds to the row the device already owns, NOT the row the code named', async () => {
    terminals = [ownedRow(), pendingRow()]
    const res = await call({ code: CODE, device_id: DEVICE })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.terminal_id).toBe(OWN_ROW)
    expect(body.terminal_id).not.toBe(PENDING_ROW)
  })

  it('issues a token naming the row the till has always been', async () => {
    terminals = [ownedRow(), pendingRow()]
    const body = await (await call({ code: CODE, device_id: DEVICE })).json()
    expect(body.accessToken).toBe(`token-for-${OWN_ROW}`)
  })

  it('keeps the terminal on its restaurant', async () => {
    terminals = [ownedRow(), pendingRow()]
    const body = await (await call({ code: CODE, device_id: DEVICE })).json()
    expect(body.restaurant_id).toBe(VENUE_A)
    expect(terminals.find((r) => r.id === OWN_ROW)!.restaurant_id).toBe(VENUE_A)
  })

  it('retires the superseded pending row instead of leaving a live code on it', async () => {
    terminals = [ownedRow(), pendingRow()]
    await call({ code: CODE, device_id: DEVICE })
    const superseded = terminals.find((r) => r.id === PENDING_ROW)!
    expect(superseded.status).toBe('revoked')
    expect(superseded.active).toBe(false)
    expect(superseded.activation_code).toBeNull()
  })

  it('creates NO second identity — the device still owns exactly one row', async () => {
    terminals = [ownedRow(), pendingRow()]
    await call({ code: CODE, device_id: DEVICE })
    const holders = terminals.filter((r) => r.device_id === DEVICE || r.device_serial === DEVICE)
    expect(holders).toHaveLength(1)
    expect(holders[0].id).toBe(OWN_ROW)
  })
})

describe('the SAME device, a DIFFERENT restaurant', () => {
  it('is refused with 409 and an actionable message', async () => {
    terminals = [ownedRow({ restaurant_id: VENUE_B }), pendingRow()]
    const res = await call({ code: CODE, device_id: DEVICE })
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('DEVICE_REGISTERED_ELSEWHERE')
    expect(body.error).toMatch(/different restaurant/i)
  })

  it('writes nothing at all', async () => {
    terminals = [ownedRow({ restaurant_id: VENUE_B }), pendingRow()]
    await call({ code: CODE, device_id: DEVICE })
    expect(updates).toHaveLength(0)
    expect(terminals.find((r) => r.id === PENDING_ROW)!.activation_code).toBe(CODE)
  })
})

describe('the protections that were already there stay there', () => {
  it('an EXPIRED activation code is refused, and says nothing about which condition failed', async () => {
    terminals = [pendingRow({ activation_code_expires_at: '2020-01-01T00:00:00.000Z' })]
    const res = await call({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid or expired activation code')
  })

  it('an ALREADY-CONSUMED code is refused the same way', async () => {
    terminals = [ownedRow()] // active, no activation_code
    const res = await call({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid or expired activation code')
  })

  it('a missing code is refused before anything is read', async () => {
    const res = await call({ device_id: DEVICE })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Activation code is required')
  })
})

describe('concurrency: the identity is claimed between the check and the write', () => {
  it('answers 409 with something actionable, never the old generic 500', async () => {
    terminals = [pendingRow()]
    updateError = { code: '23505', constraint: 'restaurant_terminals_device_id_unique' }
    const res = await call({ code: CODE, device_id: DEVICE })
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('DEVICE_IDENTITY_TAKEN')
    expect(body.error).toMatch(/reissue/i)
  })

  it('a non-duplicate write failure is a retryable 503, not a 500 dead end', async () => {
    terminals = [pendingRow()]
    updateError = { code: '08006', message: 'connection failure' }
    const res = await call({ code: CODE, device_id: DEVICE })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('ACTIVATION_WRITE_FAILED')
  })
})

describe('no refusal leaks the schema, and none is the old generic message', () => {
  const GENERIC = 'Failed to activate terminal'

  it('never returns the message that meant everything and nothing', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => {
        terminals = [ownedRow({ restaurant_id: VENUE_B }), pendingRow()]
        return call({ code: CODE, device_id: DEVICE })
      },
      async () => {
        terminals = [pendingRow()]
        updateError = { code: '23505', constraint: 'restaurant_terminals_device_id_unique' }
        return call({ code: CODE, device_id: DEVICE })
      },
      async () => {
        terminals = [pendingRow()]
        updateError = { code: '08006' }
        return call({ code: CODE, device_id: DEVICE })
      },
    ]
    for (const run of cases) {
      terminals = []
      updates = []
      updateError = null
      const body = await (await run()).json()
      expect(body.error).not.toBe(GENERIC)
      expect(body.error).not.toMatch(/restaurant_terminals|device_id|device_serial|23505|constraint/i)
    }
  })
})
