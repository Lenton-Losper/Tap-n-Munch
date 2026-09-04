/**
 * POST /api/terminal/payment-events/refund — the consume-time permission re-check.
 *
 * THE PROPERTY THIS FILE EXISTS FOR. A refund is the only terminal action that moves money back
 * out, and `payments:refund` is held by NOBODY by default. Until 2026-09-04 the permission behind
 * the `refund` purpose was checked once, at mint, and the spending route re-verified nothing — so a
 * token was bearer authority for the whole of its TTL, a window in which the authoriser can be
 * demoted, removed from the venue, or have the permission unticked.
 *
 * TWO ASSERTIONS, AND THE SECOND IS THE ONE THAT MATTERS:
 *
 *   1. the route ASKS for payments:refund when it spends the token, and
 *   2. when the answer is no, NO REFUND EVENT IS RECORDED. A gate that refuses after writing the
 *      ledger row has not gated anything — the refund is already in the books.
 *
 * The RPC is the only writer here, so "was record_terminal_refund_event called" is the whole of
 * "did money move". Every refusal below asserts it was not.
 */
import { POST } from '@/app/api/terminal/payment-events/refund/route'

const RESTAURANT = 'rest-1'
const ORDER_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'

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
const consumeCalls: Array<Record<string, unknown>> = []
jest.mock('@/lib/terminal-auth/consume-authorization-token', () => ({
  consumeAuthorizationToken: async (_sb: unknown, params: Record<string, unknown>) => {
    consumeCalls.push(params)
    return consumeResult
  },
}))

type Row = Record<string, unknown>
/** The idempotency lookup: null means "this refund has not been recorded yet". */
let existingRefund: Row | null = null
/** The original SALE the refund is against. */
let originalSale: Row | null = null
const rpcCalls: Array<{ name: string; args: Row }> = []
let paymentEventLookups = 0

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'payment_events') {
        // Two separate lookups reach this table, each through its own from() call, so the counter
        // has to live OUTSIDE the chain: the route asks for the idempotency row first, then for
        // the original SALE. A per-chain counter answers "idempotency row" to both, which is how
        // this fake first reported a spurious 400.
        paymentEventLookups += 1
        const which = paymentEventLookups
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.maybeSingle = async () => ({
          data: which === 1 ? existingRefund : originalSale,
          error: null,
        })
        return chain
      }
      if (table === 'orders') {
        return {
          select: () => ({
            in: () => ({ eq: async () => ({ data: [{ id: ORDER_ID }], error: null }) }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args })
      return { data: { id: 'event-1', event_type: args.p_event_type }, error: null }
    },
  }),
}))

function call(body: unknown) {
  return POST(
    new Request('https://example.test/api/terminal/payment-events/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const VALID = {
  token_id: TOKEN_ID,
  user_id: USER_ID,
  origin_business_order_no: 'FT-SALE-1',
  business_order_no: 'FT-REFUND-1',
  order_ids: [ORDER_ID],
  amount: 45,
  reason_code: 'customer_request',
  gateway_result: 'success',
}

beforeEach(() => {
  consumeResult = { ok: true }
  consumeCalls.length = 0
  rpcCalls.length = 0
  existingRefund = null
  originalSale = { id: 'sale-1', currency: 'NAD' }
  paymentEventLookups = 0
})

describe('the refund asks for the permission when it SPENDS the token', () => {
  it('passes requirePermission: payments:refund to the consume', async () => {
    const res = await call(VALID)
    expect(res.status).toBe(200)
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      expectedPurpose: 'refund',
      expectedUserId: USER_ID,
      requirePermission: 'payments:refund',
    })
  })

  it('records the refund when the permission holds', async () => {
    await call(VALID)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].name).toBe('record_terminal_refund_event')
    expect(rpcCalls[0].args.p_event_type).toBe('refund_succeeded')
  })
})

describe('when the permission is gone by spend time, NOTHING is recorded', () => {
  it('refuses with 403 and writes no refund event', async () => {
    // The manager was demoted, removed from the venue, or had payments:refund unticked between
    // minting the token and spending it.
    consumeResult = { ok: false, reason: 'missing_permission' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: 'missing_permission' })
    expect(rpcCalls).toHaveLength(0)
  })

  it('refuses an expired token without recording anything', async () => {
    consumeResult = { ok: false, reason: 'expired' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect(rpcCalls).toHaveLength(0)
  })

  it('refuses a token already spent, without recording anything', async () => {
    consumeResult = { ok: false, reason: 'already_used' }
    const res = await call(VALID)
    expect(res.status).toBe(403)
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('the check does not disturb what was already there', () => {
  it('still short-circuits on the idempotency key, without consuming a token', async () => {
    existingRefund = { id: 'event-existing', event_type: 'refund_succeeded' }
    const res = await call(VALID)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'event-existing' })
    // A replay must not burn the manager's authorisation.
    expect(consumeCalls).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })

  it('still refuses when the original SALE cannot be found, before consuming', async () => {
    originalSale = null
    const res = await call(VALID)
    expect(res.status).toBe(400)
    expect(consumeCalls).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })
})
