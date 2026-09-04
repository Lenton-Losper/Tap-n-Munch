/**
 * POST /api/terminal/tables/[tableId]/walkout-close — Ship 2.
 *
 * TWO PROPERTIES CARRY THIS FILE, and both are about what happens when the answer is NO:
 *
 *   1. A GATE THAT REFUSES AFTER CLOSING HAS NOT GATED ANYTHING. Every refusal below asserts that
 *      closeTableSession was never called — not merely that a 403 came back. The table must still
 *      be open when a waiter's PIN is rejected.
 *
 *   2. NO PAYMENT IS EVER WRITTEN. Before 2026-07-30 Close Table bulk-stamped paid_at/completed_at
 *      and left three production orders marked paid with no payment behind them. This route calls
 *      the existing close_table_session(), which does not touch `orders` at all — asserted here by
 *      checking it writes to no order, and proven for real by effect against production.
 */
import { POST } from '@/app/api/terminal/tables/[tableId]/walkout-close/route'

const RESTAURANT = 'rest-1'
const TABLE_ID = 'table-1'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    deviceSerial: 'dev-1',
    restaurantId: RESTAURANT,
    permissions: ['orders:read', 'orders:update', 'tables:read'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

let consumeResult: { ok: boolean; reason?: string } = { ok: true }
let consumeShouldThrow = false
const consumeCalls: Array<Record<string, unknown>> = []
jest.mock('@/lib/terminal-auth/consume-authorization-token', () => ({
  consumeAuthorizationToken: async (_sb: unknown, params: Record<string, unknown>) => {
    consumeCalls.push(params)
    if (consumeShouldThrow) throw new Error('authorization_events insert failed')
    return consumeResult
  },
}))

let guardBlocked = false
jest.mock('@/lib/tabs/pending-order-requests', () => ({
  guardTableClose: async () => (guardBlocked
    ? { blocked: true, status: 409, body: { error: 'pending request', code: 'PENDING_ORDER_REQUESTS' } }
    : { blocked: false }),
}))

const closeCalls: Array<Record<string, unknown>> = []
jest.mock('@/lib/session-manager', () => ({
  closeTableSession: async (args: Record<string, unknown>) => {
    closeCalls.push(args)
  },
}))

type Row = Record<string, unknown>
let tabRows: Row[]
let orderRows: Row[]
const auditInserts: Row[] = []
const orderWrites: Row[] = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'tabs') {
        return { select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: tabRows, error: null }) }) }) }) }
      }
      if (table === 'orders') {
        return {
          select: () => ({ in: async () => ({ data: orderRows, error: null }) }),
          // Recorded so a test can assert this route writes to NO order, ever.
          update: (patch: Row) => {
            orderWrites.push(patch)
            return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) }
          },
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            auditInserts.push(row)
            return { data: null, error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

function req(body: unknown) {
  return new Request('https://example.test/api/terminal/tables/x/walkout-close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const call = (body: unknown) => POST(req(body), { params: Promise.resolve({ tableId: TABLE_ID }) })

const VALID = {
  reason: 'Customer left without paying',
  staff_user_id: 'user-manager',
  authorization_token_id: 'tok-1',
}

beforeEach(() => {
  consumeResult = { ok: true }
  consumeShouldThrow = false
  consumeCalls.length = 0
  guardBlocked = false
  closeCalls.length = 0
  auditInserts.length = 0
  orderWrites.length = 0
  tabRows = [{ id: 'tab-1', total: 340, table_number: 5 }]
  orderRows = [
    { id: 'order-1', total: 240, payment_status: 'pending' },
    { id: 'order-2', total: 100, payment_status: 'pending' },
    { id: 'order-3', total: 500, payment_status: 'paid' },
  ]
})

describe('the gate refuses BEFORE anything closes', () => {
  it("a waiter's PIN is refused, and the table is NOT closed", async () => {
    // The permission is resolved from the purpose server-side, so a waiter's token simply does not
    // consume against 'walkout_close'. What matters here is what happens next.
    consumeResult = { ok: false, reason: 'missing_permission' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('AUTHORIZATION_INVALID')
    expect(closeCalls).toHaveLength(0)
    expect(auditInserts).toHaveLength(0)
  })

  it('an expired token is refused, and the table is NOT closed', async () => {
    consumeResult = { ok: false, reason: 'expired' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect(closeCalls).toHaveLength(0)
  })

  it('a token that THROWS fails closed, and the table is NOT closed', async () => {
    consumeShouldThrow = true
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect(closeCalls).toHaveLength(0)
  })

  it('no token at all is refused — this action is never unattributed', async () => {
    // Unlike cash settlement, where a token is optional. There is no acceptable version of an
    // unattributed write-off.
    const res = await call({ reason: 'Customer left', staff_user_id: 'user-manager' })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('AUTHORIZATION_REQUIRED')
    expect(closeCalls).toHaveLength(0)
  })

  it('consumes against the walkout_close purpose, scoped to this terminal and venue', async () => {
    await call(VALID)
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      tokenId: 'tok-1',
      expectedUserId: 'user-manager',
      expectedRestaurantId: RESTAURANT,
      expectedTerminalId: 'term-1',
      expectedPurpose: 'walkout_close',
    })
  })
})

describe('a reason is required, and is checked BEFORE the token is burnt', () => {
  it('refuses a missing reason', async () => {
    const res = await call({ staff_user_id: 'user-manager', authorization_token_id: 'tok-1' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('REASON_REQUIRED')
    expect(closeCalls).toHaveLength(0)
  })

  it('refuses a reason of whitespace', async () => {
    const res = await call({ ...VALID, reason: '    ' })
    expect(res.status).toBe(400)
    expect(closeCalls).toHaveLength(0)
  })

  it('does NOT consume the token when the reason is bad', async () => {
    // Burning a manager's single-use authorisation on a malformed request makes them walk back and
    // PIN in again for a mistake the device could have caught -- and the second attempt is where
    // people start sharing PINs.
    await call({ ...VALID, reason: '' })
    expect(consumeCalls).toHaveLength(0)
  })

  it('refuses a reason longer than the cap', async () => {
    const res = await call({ ...VALID, reason: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    expect(closeCalls).toHaveLength(0)
  })
})

describe('the close itself', () => {
  it('closes with the real users.id, not the terminal id', async () => {
    // The whole defect being fixed: `closed_by` used to be the DEVICE, which answers "which box"
    // and never "who".
    const res = await call(VALID)
    expect(res.status).toBe(200)
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0]).toMatchObject({
      closedBy: 'user-manager',
      source: 'terminal_walkout',
      tableId: TABLE_ID,
      restaurantId: RESTAURANT,
    })
    expect(closeCalls[0].closedBy).not.toBe('term-1')
  })

  it('WRITES TO NO ORDER — no paid_at, no payment_status, nothing', async () => {
    // The 2026-07-30 defect, asserted directly. Three production orders were left marked paid with
    // no payment behind them because a close stamped them.
    await call(VALID)
    expect(orderWrites).toEqual([])
  })

  it('records who, why, and how much was written off', async () => {
    await call(VALID)
    expect(auditInserts).toHaveLength(1)
    const md = auditInserts[0].metadata as Record<string, unknown>
    expect(auditInserts[0].action).toBe('tab.walkout_closed')
    expect(md.closed_by_user_id).toBe('user-manager')
    expect(md.reason).toBe('Customer left without paying')
    // Only the UNPAID orders count toward the write-off; the paid one does not.
    expect(md.unpaid_order_count).toBe(2)
    expect(md.amount_written_off).toBe(340)
    expect(md.unpaid_order_ids).toEqual(['order-1', 'order-2'])
  })

  it('captures what was owed BEFORE closing — afterwards it cannot be reconstructed', async () => {
    const res = await call(VALID)
    const body = await res.json()
    expect(body.amount_written_off).toBe(340)
    expect(body.unpaid_order_count).toBe(2)
  })

  it('still honours the pending-request guard, and does not close when it blocks', async () => {
    guardBlocked = true
    const res = await call(VALID)
    expect(res.status).toBe(409)
    expect(closeCalls).toHaveLength(0)
  })

  it('a table with nothing owing still closes, and writes off zero', async () => {
    orderRows = [{ id: 'order-3', total: 500, payment_status: 'paid' }]
    const res = await call(VALID)
    expect(res.status).toBe(200)
    expect((await res.json()).amount_written_off).toBe(0)
  })
})

/**
 * ============================================================================================
 * CONSUME-TIME PERMISSION RE-CHECK — one enforcement point is one bug away from none
 * ============================================================================================
 *
 * Until 2026-09-04 the permission was checked only at MINT, in POST /api/terminal/authorize. A
 * token was therefore bearer authority: anything holding one could spend it, and this route
 * re-verified nothing.
 *
 * Found by effect, not by reading: a probe minted a walkout token for a waiter directly, bypassing
 * the only place the check lives, and this route accepted it and closed the table. A minted token
 * also carries a TTL, and a manager can be demoted inside that window.
 */
describe('the permission is re-checked when the token is SPENT', () => {
  it('asks for tabs:close_unpaid at consume time', async () => {
    await call(VALID)
    expect(consumeCalls[0]).toMatchObject({ requirePermission: 'tabs:close_unpaid' })
  })

  it('refuses — and does NOT close — when the permission is gone by spend time', async () => {
    // A manager demoted, removed from the venue, or unticked between mint and spend.
    consumeResult = { ok: false, reason: 'missing_permission' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('missing_permission')
    expect(closeCalls).toHaveLength(0)
    expect(auditInserts).toHaveLength(0)
  })
})
