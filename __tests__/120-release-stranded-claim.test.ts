/**
 * #120's RESIDUAL — the manual escape hatch for a claim stranded in `accepting`.
 *
 * The route exists because #120's fail-closed turned a silent bug into a blocking one: a request
 * stuck mid-accept now holds a bill open, and per #215 no reaper can clear it until the claim
 * records a timestamp.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING is not "the happy path works". It is the three refusals,
 * because each of them is a way this button could become the #120 bug again from the other side:
 *
 *   a `waiting_review` row must NOT be releasable   — that is a real round a customer placed
 *   another restaurant's row must NOT be visible    — cross-tenant
 *   a row someone else resolved must NOT be re-written under them — the conditional update
 */
import { POST } from '@/app/api/terminal/order-requests/[requestId]/release/route'

const RESTAURANT = 'aaaaaaaa-0000-0000-0000-000000000001'
const OTHER_RESTAURANT = 'bbbbbbbb-0000-0000-0000-000000000002'
const REQUEST_ID = 'cccccccc-0000-0000-0000-000000000003'

let terminalPermissions: string[] = ['orders:update']
let loadedRow: Record<string, unknown> | null = null
let loadError: unknown = null
let updateMatchesRow = true
let updateError: unknown = null
const auditInserts: Record<string, unknown>[] = []
let auditThrows = false
let writtenUpdate: Record<string, unknown> | null = null

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: jest.fn(async () => ({
    terminalId: 'terminal-1',
    restaurantId: RESTAURANT,
    permissions: terminalPermissions,
  })),
  validateTerminalRecord: jest.fn(async () => undefined),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (auditThrows) throw new Error('audit is down')
            auditInserts.push(row)
            return { error: null }
          },
        }
      }
      if (table !== 'order_requests') throw new Error(`unexpected table ${table}`)
      const conditions: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {
        _isUpdate: false,
        select() {
          return builder
        },
        update(patch: Record<string, unknown>) {
          builder._isUpdate = true
          // RECORD what the route actually wrote. The first version of this mock returned a
          // hardcoded { status: 'waiting_review' }, so the assertion that the row is released to
          // waiting_review was reading the MOCK, not the route — and mutating the route to write
          // 'accepted' left all 13 tests green. The single most important property of this file
          // was untested until that mutation exposed it.
          writtenUpdate = patch
          return builder
        },
        eq(col: string, val: unknown) {
          conditions[col] = val
          return builder
        },
        async maybeSingle() {
          if (builder._isUpdate) {
            if (updateError) return { data: null, error: updateError }
            // The route's safety is this predicate being applied by the DB, not by the read.
            const matched = updateMatchesRow && conditions.status === 'accepting'
            // Echo the WRITTEN value back, the way the database would.
            return {
              data: matched ? { id: REQUEST_ID, status: (writtenUpdate as { status?: string } | null)?.status } : null,
              error: null,
            }
          }
          if (loadError) return { data: null, error: loadError }
          return { data: loadedRow, error: null }
        },
      }
      return builder
    },
  }),
}))

const call = () =>
  POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ requestId: REQUEST_ID }),
  })

beforeEach(() => {
  terminalPermissions = ['orders:update']
  loadedRow = { id: REQUEST_ID, restaurant_id: RESTAURANT, tab_id: 'tab-1', table_id: 'table-1', status: 'accepting' }
  loadError = null
  updateMatchesRow = true
  updateError = null
  auditThrows = false
  auditInserts.length = 0
  writtenUpdate = null
})

describe('releasing a stranded accept claim', () => {
  it('releases an accepting row to waiting_review, never to accepted', async () => {
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('waiting_review')
    // Asserted against what the ROUTE WROTE, not against the mock's canned reply.
    expect(writtenUpdate).toEqual({ status: 'waiting_review' })
    // The whole point: a dead worker proves nothing about whether the round was wanted.
    expect(writtenUpdate).not.toMatchObject({ status: 'accepted' })
    expect(writtenUpdate).not.toMatchObject({ status: 'declined' })
    expect(body.status).not.toBe('accepted')
  })

  it('writes an audit row naming the transition and the reason', async () => {
    await call()
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0]).toMatchObject({
      restaurant_id: RESTAURANT,
      action: 'order_request.claim_released',
      entity_type: 'order_request',
      entity_id: REQUEST_ID,
    })
    const meta = auditInserts[0].metadata as Record<string, unknown>
    expect(meta.from).toBe('accepting')
    expect(meta.to).toBe('waiting_review')
    expect(String(meta.reason)).toMatch(/stranded/i)
  })

  it('still releases when the AUDIT write throws — the trail must not fail the release', async () => {
    auditThrows = true
    const res = await call()
    expect(res.status).toBe(200)
    // A stuck table freed but not logged beats one still stuck because the log was down.
  })
})

describe('the three refusals — each is the #120 bug from the other side', () => {
  it('REFUSES a waiting_review row: that is a real round a customer placed', async () => {
    loadedRow = { ...(loadedRow as object), status: 'waiting_review' }
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('NOT_A_STRANDED_CLAIM')
    expect(body.status).toBe('waiting_review')
    expect(auditInserts).toHaveLength(0)
  })

  it.each(['accepted', 'declined'])('REFUSES an already-decided row (%s)', async (status) => {
    loadedRow = { ...(loadedRow as object), status }
    const res = await call()
    expect(res.status).toBe(409)
    expect(auditInserts).toHaveLength(0)
  })

  it("REFUSES another restaurant's row, and does not confirm it exists", async () => {
    loadedRow = { ...(loadedRow as object), restaurant_id: OTHER_RESTAURANT }
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(404)
    // 404 not 403: a cross-tenant caller learns nothing about whether the id is real.
    expect(String(body.error)).toBe('Request not found')
    expect(auditInserts).toHaveLength(0)
  })

  it('REFUSES when the conditional update matches nothing — someone else resolved it first', async () => {
    updateMatchesRow = false
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('ALREADY_RESOLVED')
    expect(auditInserts).toHaveLength(0)
  })
})

describe('it fails closed, and says which failure', () => {
  it('503s when the row cannot be read, rather than assuming nothing is stranded', async () => {
    loadError = { message: 'connection reset' }
    const res = await call()
    expect(res.status).toBe(503)
    expect(auditInserts).toHaveLength(0)
  })

  it('503s when the update errors', async () => {
    updateError = { message: 'deadlock detected' }
    const res = await call()
    expect(res.status).toBe(503)
    expect(auditInserts).toHaveLength(0)
  })

  it('404s an unknown id', async () => {
    loadedRow = null
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('403s without orders:update', async () => {
    terminalPermissions = []
    const res = await call()
    expect(res.status).toBe(403)
    expect(auditInserts).toHaveLength(0)
  })
})

describe('CONTROL', () => {
  it('the happy path really is reachable in this harness', async () => {
    // Without this, every refusal above could pass because the route always refuses.
    const res = await call()
    expect(res.status).toBe(200)
  })
})
