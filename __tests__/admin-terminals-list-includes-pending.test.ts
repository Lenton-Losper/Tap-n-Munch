/**
 * Issue #193 (Q3) — GET /api/admin/terminals/list filtered `.in('status', ['active','inactive'])`,
 * so a newly generated terminal was invisible on Settings -> Payments.
 *
 * All three UI callers of POST /api/admin/terminals/generate-code post an empty body, which takes
 * the branch inserting status='pending' (generate-code/route.ts:32). Nothing ever writes the
 * intermediate value the filter expected, so between generating an activation code and the
 * terminal activating itself (app/api/terminals/activate/route.ts:62 sets 'active') the row was
 * absent from the only payload that tab reads — the operator had a code on screen for a device
 * the page said did not exist.
 *
 * The stub below APPLIES `.eq()` and `.in()` rather than recording them, so a test cannot pass by
 * the route dropping the filter server-side and something else compensating. 'revoked' is included
 * in the fixture on purpose: the fix is to widen the allowlist by one value, not to delete it.
 */
import { GET } from '@/app/api/admin/terminals/list/route'

type Row = Record<string, unknown>

const RESTAURANT = 'rest-193'

/** Activated device. Was visible before and must stay visible. */
const ROW_ACTIVE: Row = {
  id: 'term-active',
  restaurant_id: RESTAURANT,
  terminal_name: 'Till 1',
  device_serial: 'SN-ACTIVE',
  model: 'A920',
  status: 'active',
  activation_code: null,
  activation_code_expires_at: null,
  created_at: '2026-08-01T10:00:00Z',
}

/** Deactivated via settings-payment-tab.tsx:446. Reachable behind the "Show inactive" toggle. */
const ROW_INACTIVE: Row = {
  id: 'term-inactive',
  restaurant_id: RESTAURANT,
  terminal_name: 'Till 2',
  device_serial: 'SN-INACTIVE',
  model: 'A920',
  status: 'inactive',
  activation_code: null,
  activation_code_expires_at: null,
  created_at: '2026-08-02T10:00:00Z',
}

/** Just generated a code, not yet activated. The row the defect hid. */
const ROW_PENDING: Row = {
  id: 'term-pending',
  restaurant_id: RESTAURANT,
  terminal_name: 'New Terminal',
  device_serial: null,
  model: null,
  status: 'pending',
  activation_code: '481920',
  activation_code_expires_at: '2099-01-01T00:00:00Z',
  created_at: '2026-08-03T10:00:00Z',
}

/** Revoked. Excluded before, and must stay excluded. */
const ROW_REVOKED: Row = {
  id: 'term-revoked',
  restaurant_id: RESTAURANT,
  terminal_name: 'Stolen device',
  device_serial: 'SN-REVOKED',
  model: 'A920',
  status: 'revoked',
  activation_code: null,
  activation_code_expires_at: null,
  created_at: '2026-08-04T10:00:00Z',
}

/** Another tenant's pending terminal — widening the status filter must not widen tenancy. */
const ROW_OTHER_TENANT: Row = {
  id: 'term-other',
  restaurant_id: 'rest-other',
  terminal_name: 'Someone else',
  device_serial: 'SN-OTHER',
  model: 'A920',
  status: 'pending',
  activation_code: '999999',
  activation_code_expires_at: '2099-01-01T00:00:00Z',
  created_at: '2026-08-05T10:00:00Z',
}

const ALL_ROWS = [ROW_ACTIVE, ROW_INACTIVE, ROW_PENDING, ROW_REVOKED, ROW_OTHER_TENANT]

/** Minimal PostgREST-shaped stub over `restaurant_terminals` that applies eq / in / order. */
function makeSupabaseStub(rows: Row[]) {
  const applied: {
    eq: Array<[string, unknown]>
    in: Array<[string, readonly unknown[]]>
  } = { eq: [], in: [] }

  const resolve = () => {
    let out = rows
    for (const [column, value] of applied.eq) {
      out = out.filter((row) => String(row[column] ?? '') === String(value))
    }
    for (const [column, values] of applied.in) {
      const allowed = values.map((v) => String(v))
      out = out.filter((row) => allowed.includes(String(row[column] ?? '')))
    }
    return { data: out, error: null }
  }

  const builder = {
    eq(column: string, value: unknown) {
      applied.eq.push([column, value])
      return builder
    },
    in(column: string, values: readonly unknown[]) {
      applied.in.push([column, values])
      return builder
    },
    order() {
      return builder
    },
    then(onFulfilled: (r: ReturnType<typeof resolve>) => unknown) {
      return Promise.resolve(onFulfilled(resolve()))
    },
  }

  return {
    applied,
    client: {
      from(table: string) {
        if (table !== 'restaurant_terminals') throw new Error(`unexpected table ${table}`)
        return { select: () => builder }
      },
    },
  }
}

let stub = makeSupabaseStub(ALL_ROWS)

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => stub.client,
}))

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-193' }),
  getRestaurantIdForUser: async () => 'rest-193',
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

beforeEach(() => {
  stub = makeSupabaseStub(ALL_ROWS)
})

async function call() {
  const res = await GET(new Request('https://example.test/api/admin/terminals/list'))
  const body = (await res.json()) as { terminals?: Row[]; error?: string }
  return { status: res.status, ids: (body.terminals || []).map((t) => String(t.id)), body }
}

describe('GET /api/admin/terminals/list — status visibility', () => {
  it('returns a freshly generated terminal, which is status=pending', async () => {
    const { status, ids } = await call()
    expect(status).toBe(200)
    expect(ids).toContain('term-pending')
  })

  it('still returns active and inactive terminals', async () => {
    const { ids } = await call()
    expect(ids).toContain('term-active')
    expect(ids).toContain('term-inactive')
  })

  it('still excludes revoked terminals', async () => {
    const { ids } = await call()
    expect(ids).not.toContain('term-revoked')
  })

  it('carries the activation code a pending terminal needs on screen', async () => {
    const { body } = await call()
    const pending = (body.terminals || []).find((t) => t.id === 'term-pending')
    expect(pending?.activation_code).toBe('481920')
  })

  it('does not leak another restaurant’s pending terminal', async () => {
    const { ids } = await call()
    expect(ids).not.toContain('term-other')
    expect(stub.applied.eq).toContainEqual(['restaurant_id', 'rest-193'])
  })

  it('applies the status allowlist in the query, not after it', async () => {
    await call()
    const statusFilter = stub.applied.in.find(([column]) => column === 'status')
    expect(statusFilter).toBeDefined()
    expect(statusFilter?.[1]).toContain('pending')
  })
})
