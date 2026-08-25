/**
 * #265 — staff-triggered PIN recovery, staff never sees the PIN.
 *
 * Two routes, one flow:
 *   POST /api/tabs/[tabId]/reset-pin   staff/terminal-auth. Mints pin_reset_token +
 *                                      expiry, returns a recovery URL. Never touches
 *                                      tab_pin or session_version.
 *   POST /api/tabs/[tabId]/join        guest-facing. A valid `resetToken` mints a NEW
 *                                      tab_pin, clears both reset columns in the same
 *                                      write, and returns the new PIN to the caller --
 *                                      the only place it is ever returned.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const TABLE_ID = 'b2c3d4e5-1234-4a6d-9a3e-1f5c2b8d4e88'

type Row = Record<string, unknown>

let tabRow: Row
const auditInserts: Row[] = []
/** #216: writes to restaurant_tables, kept apart from the tabs patch this suite inspects. */
const tableUpdates: Row[] = []
const tabUpdates: Row[] = []

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/base-url', () => ({
  buildMenuUrl: (restaurantId: string, tableNumber: number) =>
    `https://example.test/menu/${restaurantId}/v2?table=${tableNumber}`,
}))

jest.mock('@/lib/tabs/generate-tab-pin', () => ({
  generateTabPin: () => '9999',
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => RESTAURANT_UUID,
}))

jest.mock('@/lib/session-token', () => ({
  issueTokenForOpenTab: async () => 'session-token-abc',
}))

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            auditInserts.push(row)
            return { error: null }
          },
        }
      }
      /**
       * #216 added a second table to this route: a successful join marks the table `occupied`,
       * because a table holding a live tab that is not `'occupied'` is invisible on the payment
       * terminal and staff cannot take payment on it.
       *
       * Recorded separately from the `tabs` builder so the reset-token assertions below — which
       * inspect the tabs patch exactly — cannot be disturbed by a write that has nothing to do
       * with #265.
       */
      if (table === 'restaurant_tables') {
        const b: Record<string, unknown> = {
          update: (row: Row) => {
            tableUpdates.push(row)
            return b
          },
          eq: () => b,
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        }
        return b
      }
      if (table !== 'tabs') throw new Error(`unexpected table ${table}`)

      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') === String(val))
          return builder
        },
        update: (p: Row) => {
          patch = p
          return builder
        },
        single: async () => {
          const match = filters.every((f) => f(tabRow))
          return match ? { data: tabRow, error: null } : { data: null, error: { message: 'not found' } }
        },
        maybeSingle: async () => {
          const match = filters.every((f) => f(tabRow))
          if (patch) {
            if (match) {
              tabUpdates.push({ ...patch })
              Object.assign(tabRow, patch)
              return { data: { id: tabRow.id }, error: null }
            }
            return { data: null, error: null }
          }
          return match ? { data: tabRow, error: null } : { data: null, error: null }
        },
        // reset-pin's update has no .select()/.maybeSingle() -- it is awaited directly.
        // Applies the patch the same way maybeSingle does, so a bare `await builder` still
        // mutates tabRow.
        then: (resolve: (v: { data: null; error: null }) => unknown) => {
          const match = filters.every((f) => f(tabRow))
          if (patch && match) {
            tabUpdates.push({ ...patch })
            Object.assign(tabRow, patch)
          }
          return Promise.resolve({ data: null, error: null }).then(resolve)
        },
      }
      return builder
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabase(),
}))

function baseTab(): Row {
  return {
    id: TAB_ID,
    restaurant_id: RESTAURANT_UUID,
    table_id: TABLE_ID,
    table_number: 12,
    status: 'open',
    members: [],
    tab_pin: '1234',
    pin_required: true,
    pin_reset_token: null,
    pin_reset_token_expires_at: null,
    session_version: 3,
  }
}

function makeReq(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('#265 — POST /api/tabs/[tabId]/reset-pin', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditInserts.length = 0
    tableUpdates.length = 0
    tabUpdates.length = 0
    tabRow = baseTab()
  })

  test('mints a token and expiry, returns a recovery URL, never touches tab_pin or session_version', async () => {
    const { POST } = await import('@/app/api/tabs/[tabId]/reset-pin/route')
    const res = await POST(
      new NextRequest('https://example.test/api/tabs/x/reset-pin', { method: 'POST' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.recoveryUrl).toBe(
      `https://example.test/menu/${RESTAURANT_UUID}/v2?table=12&pinReset=${tabRow.pin_reset_token}`,
    )
    expect(tabRow.pin_reset_token).toEqual(expect.any(String))
    // Unaffected -- a PIN reset must not disturb an already-valid session or the PIN itself.
    expect(tabRow.tab_pin).toBe('1234')
    expect(tabRow.session_version).toBe(3)

    const audit = auditInserts.find((a) => a.action === 'tab.pin_reset_requested')
    expect(audit).toBeDefined()
    // The token itself must never be logged.
    expect(JSON.stringify(audit)).not.toContain(String(tabRow.pin_reset_token))
  })

  test('missing permission is refused', async () => {
    jest.doMock('@/lib/terminal-auth', () => ({
      requireTerminalAuth: async () => ({
        restaurantId: RESTAURANT_UUID,
        terminalId: 't1',
        deviceSerial: 'TESTSN0001',
        permissions: [],
      }),
      validateTerminalRecord: async () => undefined,
    }))
    jest.resetModules()
    const { POST } = await import('@/app/api/tabs/[tabId]/reset-pin/route')
    const res = await POST(
      new NextRequest('https://example.test/api/tabs/x/reset-pin', { method: 'POST' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('#265 — POST /api/tabs/[tabId]/join, resetToken branch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditInserts.length = 0
    tableUpdates.length = 0
    tabUpdates.length = 0
    tabRow = baseTab()
  })

  test('a live token mints a NEW pin, clears both reset columns, and returns the new pin', async () => {
    tabRow.pin_reset_token = 'reset-token-live'
    tabRow.pin_reset_token_expires_at = new Date(Date.now() + 60_000).toISOString()

    const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
    const res = await POST(
      makeReq('https://example.test/api/tabs/x/join', {
        restaurantId: RESTAURANT_UUID,
        tableNumber: 12,
        resetToken: 'reset-token-live',
        sessionId: 'sess-1',
        displayName: 'Alex',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.tabPin).toBe('9999')
    expect(tabRow.tab_pin).toBe('9999')
    expect(tabRow.pin_reset_token).toBeNull()
    expect(tabRow.pin_reset_token_expires_at).toBeNull()
    // Still not touched by a PIN reset.
    expect(tabRow.session_version).toBe(3)

    const audit = auditInserts.find((a) => a.action === 'tab.pin_reset_redeemed')
    expect(audit).toBeDefined()
    expect(JSON.stringify(audit)).not.toContain('9999')
    expect(JSON.stringify(audit)).not.toContain('1234')
  })

  test('an expired token is refused, not silently treated as a normal PIN-required join', async () => {
    tabRow.pin_reset_token = 'reset-token-expired'
    tabRow.pin_reset_token_expires_at = new Date(Date.now() - 60_000).toISOString()

    const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
    const res = await POST(
      makeReq('https://example.test/api/tabs/x/join', {
        restaurantId: RESTAURANT_UUID,
        tableNumber: 12,
        resetToken: 'reset-token-expired',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(String(json.error)).toMatch(/expired|already been used/i)
    expect(tabRow.tab_pin).toBe('1234') // unchanged
  })

  test('a wrong token is refused', async () => {
    tabRow.pin_reset_token = 'reset-token-live'
    tabRow.pin_reset_token_expires_at = new Date(Date.now() + 60_000).toISOString()

    const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
    const res = await POST(
      makeReq('https://example.test/api/tabs/x/join', {
        restaurantId: RESTAURANT_UUID,
        tableNumber: 12,
        resetToken: 'not-the-right-token',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(403)
    expect(tabRow.tab_pin).toBe('1234')
  })

  test('a token consumed once cannot be consumed again (race loser gets refused, not a phantom pin)', async () => {
    tabRow.pin_reset_token = 'reset-token-live'
    tabRow.pin_reset_token_expires_at = new Date(Date.now() + 60_000).toISOString()

    const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
    const req = () =>
      makeReq('https://example.test/api/tabs/x/join', {
        restaurantId: RESTAURANT_UUID,
        tableNumber: 12,
        resetToken: 'reset-token-live',
        sessionId: 'sess-1',
      })

    const first = await POST(req(), { params: Promise.resolve({ tabId: TAB_ID }) })
    expect(first.status).toBe(200)

    const second = await POST(req(), { params: Promise.resolve({ tabId: TAB_ID }) })
    expect(second.status).toBe(403)
  })

  test('no resetToken: ordinary PIN-required behaviour is unchanged (control)', async () => {
    const { POST } = await import('@/app/api/tabs/[tabId]/join/route')
    const res = await POST(
      makeReq('https://example.test/api/tabs/x/join', {
        restaurantId: RESTAURANT_UUID,
        tableNumber: 12,
        pin: '1234',
        sessionId: 'sess-1',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.tabPin).toBeUndefined()
    expect(tabRow.tab_pin).toBe('1234')
  })
})
