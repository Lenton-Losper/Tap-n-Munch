/**
 * POST /api/terminal/tabs/[tabId]/settle-allocations -- the settle-by-allocation route wrapping
 * settle_order_line_allocations() and order_is_fully_paid_by_allocations(). What a mock can
 * honestly assert: input validation, the RPC call shape, that an order is only flipped to paid
 * when order_is_fully_paid_by_allocations() says so, and that it is flipped exactly once (the
 * UPDATE... WHERE payment_status <> 'paid' guard). The claim/race-safety of the underlying SQL
 * function is proven for real in scripts/prod/probe-item-split-rounding-staging.ts, the same
 * split every other real-Postgres probe in this session uses.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const TABLE_ID = 'table-1'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    deviceSerial: 'dev-1',
    restaurantId: RESTAURANT,
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

let featureAllowed = true
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: featureAllowed }),
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: jest.fn(async () => {}),
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

jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: jest.fn(async () => ({ reopened: false, readyToPayPreserved: false })),
}))

type Row = Record<string, unknown>

let tabRow: Row | null
let rpcSettleResponse: { data: unknown; error: unknown }
let fullyPaidResponses: Record<string, boolean>
let appliedAllocationRows: Row[]
let orderUpdateCalls: Row[]
let orderUpdateShouldClaim: boolean
let tabOrderRows: Row[]
let rpcCalls: Array<{ name: string; args: unknown }>
let inFlightOrderRows: Row[]
let inFlightOrdersError: { message: string } | null

/**
 * THE ALLOCATION-SCOPED CARD HOLD (terminal_payment_intents).
 *
 * A part-order card charge holds the allocations it named for as long as its intent is unresolved
 * -- `launched` or `uncertain`. This route asks who holds what before it settles anything.
 *
 * `heldIntentRows` are the rows the overlap query returns; `intentByIdRows` is what a lookup of one
 * intent by id returns, which is how an intent settles its OWN items without being blocked by its
 * own hold. `intentsReadError` models the read failing, which must refuse rather than proceed.
 */
let heldIntentRows: Row[]
let intentByIdRow: Row | null
let intentsReadError: { message: string } | null

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'tabs') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: tabRow, error: tabRow ? null : { message: 'not found' } }),
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }
      }
      if (table === 'order_line_allocations') {
        return {
          select: () => ({
            // `.in(...)` is CHAINABLE and thenable: the route now calls
            // .in('id', ids).eq('restaurant_id', ...) to resolve which orders these allocations
            // belong to, and also awaits .in(...) directly when re-reading applied rows.
            in: () => {
              const res = { data: appliedAllocationRows, error: null }
              const node: Record<string, unknown> = {
                eq: async () => res,
                then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
                  Promise.resolve(res).then(ok, no),
              }
              return node
            },
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    is: async () => ({ data: [{ id: 'alloc-1' }], error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            // Tab-total recalculation: .select().eq(tab_id)
            eq: async () => ({ data: tabOrderRows, error: null }),
            // Card-in-flight guard: .select().in(ids).eq(restaurant_id)
            in: () => ({
              eq: async () => ({ data: inFlightOrderRows, error: inFlightOrdersError }),
            }),
          }),
          update: (patch: Row) => ({
            eq: () => ({
              eq: () => ({
                not: () => ({
                  select: async () => {
                    orderUpdateCalls.push(patch)
                    return { data: orderUpdateShouldClaim ? [{ id: 'order-1' }] : [], error: null }
                  },
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'terminal_payment_intents') {
        return {
          select: () => ({
            eq: () => ({
              // allocationIdsHeldByLiveCard: .eq(restaurant).eq(scope).in(status).overlaps(ids)
              eq: () => ({
                in: () => ({
                  overlaps: async () => ({
                    data: intentsReadError ? null : heldIntentRows,
                    error: intentsReadError,
                  }),
                }),
              }),
              // intentHoldsExactly: .eq(id).maybeSingle()
              maybeSingle: async () => ({
                data: intentsReadError ? null : intentByIdRow,
                error: intentsReadError,
              }),
            }),
          }),
        }
      }
      if (table === 'audit_logs') {
        return { insert: async () => ({ data: null, error: null }) }
      }
      /**
       * LOUD, DELIBERATELY. A fake that quietly returned an empty result for a table it does not
       * model would let a hold read as "nobody holds these" -- the exact fail-open this route was
       * changed to close. Throwing turns a missing branch into a 503 somebody has to look at.
       */
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      if (name === 'settle_order_line_allocations') return rpcSettleResponse
      if (name === 'order_is_fully_paid_by_allocations') {
        const orderId = (args as { p_order_id: string }).p_order_id
        return { data: fullyPaidResponses[orderId] ?? false, error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabase(),
}))

function req(body: unknown) {
  return new Request('https://example.test/api/terminal/tabs/x/settle-allocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function call(body: unknown, tabId = TAB_ID) {
  return POST(req(body), { params: Promise.resolve({ tabId }) })
}

beforeEach(() => {
  featureAllowed = true
  tabRow = { id: TAB_ID, table_id: TABLE_ID, status: 'open', settled_at: null }
  rpcSettleResponse = {
    data: { applied: [{ allocation_id: 'alloc-1', amount_cents: 3334 }], refused: [] },
    error: null,
  }
  fullyPaidResponses = {}
  appliedAllocationRows = [{ id: 'alloc-1', order_id: 'order-1' }]
  orderUpdateCalls = []
  orderUpdateShouldClaim = true
  tabOrderRows = []
  rpcCalls = []
  // No card in flight by default: the guard is off the happy path.
  inFlightOrderRows = [{ id: 'order-1', payment_status: 'pending', terminal_pushed_at: null }]
  inFlightOrdersError = null
  heldIntentRows = []
  intentByIdRow = null
  intentsReadError = null
  consumeResult = { ok: true }
  consumeShouldThrow = false
  consumeCalls.length = 0
})

describe('POST /api/terminal/tabs/[tabId]/settle-allocations', () => {
  it('refuses when station_screens_enabled is off', async () => {
    featureAllowed = false
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(403)
  })

  it('rejects an unsupported method', async () => {
    const res = await call({ allocation_ids: ['alloc-1'], method: 'bitcoin' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('UNSUPPORTED_PAYMENT_METHOD')
  })

  it('404s when the tab is not found', async () => {
    tabRow = null
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(404)
  })

  it('rejects when neither allocation_ids nor allocated_to resolve to anything', async () => {
    const res = await call({ allocation_ids: [], method: 'cash' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_ALLOCATIONS')
  })

  it('calls settle_order_line_allocations with the tab, restaurant and allocation ids', async () => {
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    const settleCall = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')!
    const args = settleCall.args as Record<string, unknown>
    expect(args.p_restaurant_id).toBe(RESTAURANT)
    expect(args.p_tab_id).toBe(TAB_ID)
    expect(args.p_allocation_ids).toEqual(['alloc-1'])
    expect(args.p_method).toBe('cash')
  })

  it('returns 409 when nothing could be settled', async () => {
    rpcSettleResponse = {
      data: { applied: [], refused: [{ allocation_id: 'alloc-1', reason: 'already_settled' }] },
      error: null,
    }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('NOTHING_SETTLED')
  })

  it('does NOT flip the order to paid when order_is_fully_paid_by_allocations says false', async () => {
    fullyPaidResponses = { 'order-1': false }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    expect(orderUpdateCalls).toHaveLength(0)
    const body = await res.json()
    expect(body.completed_order_ids).toEqual([])
  })

  it('flips the order to paid exactly once when order_is_fully_paid_by_allocations says true', async () => {
    fullyPaidResponses = { 'order-1': true }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    expect(orderUpdateCalls).toHaveLength(1)
    expect(orderUpdateCalls[0].payment_status).toBe('paid')
    expect(orderUpdateCalls[0].status).toBe('completed')
    const body = await res.json()
    expect(body.completed_order_ids).toEqual(['order-1'])
  })

  it('does not report an order as completed if the guarded UPDATE claimed nothing (already paid)', async () => {
    fullyPaidResponses = { 'order-1': true }
    orderUpdateShouldClaim = false
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    const body = await res.json()
    expect(body.completed_order_ids).toEqual([])
  })

  it('resolves allocated_to to that member\'s live unsettled allocations when allocation_ids is omitted', async () => {
    const res = await call({ allocated_to: 'Sam', method: 'cash' })
    expect(res.status).toBe(200)
    // The member lookup path used .eq chains, not .in -- reaching settle at all proves it resolved.
    const settleCall = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')!
    expect(settleCall).toBeTruthy()
  })
})

/**
 * ============================================================================================
 * THE TWO GAPS THE ROUTE'S OWN HEADER DECLARED, CLOSED 2026-09-03
 * ============================================================================================
 *
 * Both handle real money, and both were documented as deliberate omissions:
 *
 *   "Does not consume a cash-authorization token... staff_user_id is recorded when supplied,
 *    unverified."
 *   "Does not implement the whole-order route's card-in-flight guard: that guard exists for a
 *    card payment race that is specific to per-order settlement's own push/poll flow."
 *
 * The second reasoning was wrong in the direction that costs a customer money. The race belongs to
 * the ORDER, not to the flow: if a card attempt is live on order X and the gateway may still
 * answer yes, taking cash against X charges twice -- whether the cash covered the whole order or
 * one diner's share of it.
 */
describe('card-in-flight guard', () => {
  const PUSHED_NOW = () => new Date().toISOString()

  it('refuses CASH while a card is in flight on an order these allocations touch', async () => {
    inFlightOrderRows = [
      { id: 'order-1', payment_status: 'terminal_pending', terminal_pushed_at: PUSHED_NOW() },
    ]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CARD_PAYMENT_IN_FLIGHT')
    expect(body.order_ids).toEqual(['order-1'])
    // A countdown, so the terminal can say "try again in N" rather than refuse without explaining.
    expect(body.retry_after_seconds).toBeGreaterThan(0)
  })

  it('TAKES NO MONEY when it refuses -- the RPC is never reached', async () => {
    // The assertion that matters. A guard that refuses AFTER settling has not guarded anything.
    inFlightOrderRows = [
      { id: 'order-1', payment_status: 'terminal_pending', terminal_pushed_at: PUSHED_NOW() },
    ]
    await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
    expect(orderUpdateCalls).toHaveLength(0)
  })

  it('allows cash once the attempt is past the timeout -- a dead reader cannot strand a table', async () => {
    inFlightOrderRows = [
      {
        id: 'order-1',
        payment_status: 'terminal_pending',
        terminal_pushed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
    ]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(200)
  })

  it('does NOT block a CARD settlement -- the guard is cash-specific', async () => {
    inFlightOrderRows = [
      { id: 'order-1', payment_status: 'terminal_pending', terminal_pushed_at: PUSHED_NOW() },
    ]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'card' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(200)
  })

  it('FAILS CLOSED when the payment state cannot be read', async () => {
    // Not being able to see whether a card is in flight is not permission to take cash.
    inFlightOrdersError = { message: 'connection reset' }
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('IN_FLIGHT_CHECK_FAILED')
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })
})

describe('cash-authorization token', () => {
  it('refuses a token supplied without a staff id', async () => {
    const res = await POST(
      req({ allocation_ids: ['alloc-1'], method: 'cash', authorization_token_id: 'tok-1' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('ATTRIBUTION_INCOMPLETE')
  })

  it('consumes the token against the cash_settlement purpose, scoped to this terminal', async () => {
    consumeResult = { ok: true }
    await POST(
      req({
        allocation_ids: ['alloc-1'],
        method: 'cash',
        authorization_token_id: 'tok-1',
        staff_user_id: 'user-9',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      tokenId: 'tok-1',
      expectedUserId: 'user-9',
      expectedRestaurantId: RESTAURANT,
      expectedTerminalId: 'term-1',
      expectedPurpose: 'cash_settlement',
    })
  })

  it('refuses -- and TAKES NO MONEY -- when the token is rejected', async () => {
    consumeResult = { ok: false, reason: 'expired' }
    const res = await POST(
      req({
        allocation_ids: ['alloc-1'],
        method: 'cash',
        authorization_token_id: 'tok-1',
        staff_user_id: 'user-9',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('AUTHORIZATION_INVALID')
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })

  it('fails closed when consuming the token THROWS', async () => {
    // Consuming a token also writes an authorization_events row; letting that write escape would
    // land in the generic catch and answer 401, which tells staff nothing about the refusal.
    consumeShouldThrow = true
    const res = await POST(
      req({
        allocation_ids: ['alloc-1'],
        method: 'cash',
        authorization_token_id: 'tok-1',
        staff_user_id: 'user-9',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(403)
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })

  it('passes the VERIFIED staff id to the RPC, never the raw body field', async () => {
    // The ledger is append-only. A staff id nobody authorised cannot be corrected afterwards.
    consumeResult = { ok: true }
    await POST(
      req({
        allocation_ids: ['alloc-1'],
        method: 'cash',
        authorization_token_id: 'tok-1',
        staff_user_id: 'user-9',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const call = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')
    expect((call!.args as { p_staff_user_id: string }).p_staff_user_id).toBe('user-9')
  })

  it('records NULL attribution when no token was supplied, rather than an unproven staff id', async () => {
    await POST(
      req({ allocation_ids: ['alloc-1'], method: 'cash', staff_user_id: 'user-9' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    const call = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')
    expect((call!.args as { p_staff_user_id: string | null }).p_staff_user_id).toBeNull()
  })
})

/**
 * ================================================================================================
 * THE ALLOCATION-SCOPED CARD HOLD
 * ================================================================================================
 *
 * The card-in-flight guard above is ORDER-scoped: it asks whether a whole-order card push is
 * outstanding. It cannot see a part-order card charge, because that charge is not attached to an
 * order at all -- it names allocations. So a second guard asks who holds these particular items.
 *
 * WHAT GOES WRONG WITHOUT IT: three people are splitting a bill, one is mid-charge on their share,
 * and the waiter takes cash for the same items from somebody else. The card lands. The table has
 * paid twice for one plate of food, and only one of the two payments is visible on the terminal.
 *
 * An UNCERTAIN intent holds too, and that is the point of it. "We did not get a yes" is not "the
 * customer was not charged" -- E04111 from this gateway means no record, never not paid -- so the
 * items stay held until a webhook or a human resolves it, and nothing auto-releases them.
 */
describe('the allocation-scoped card hold', () => {
  const HELD = { allocation_ids: ['alloc-1'], status: 'launched' }

  it('refuses cash for items a live card charge is holding, and takes no money doing it', async () => {
    heldIntentRows = [HELD]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('ITEMS_HELD_BY_CARD')
    expect(body.allocation_ids).toEqual(['alloc-1'])

    // The assertion that matters: a guard that refuses AFTER settling has not guarded anything.
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
    expect(orderUpdateCalls).toHaveLength(0)
  })

  it('an UNCERTAIN intent holds exactly as hard as a launched one', async () => {
    /**
     * The whole reason the hold exists. An ambiguous reader result is the case where the customer
     * most likely HAS been charged and the terminal cannot prove it -- releasing the items there
     * is how the same food gets paid for twice.
     */
    heldIntentRows = [{ allocation_ids: ['alloc-1'], status: 'uncertain' }]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ITEMS_HELD_BY_CARD')
  })

  it('refuses a CARD settlement on held items too -- the hold is not cash-specific', async () => {
    // Unlike the order-scoped in-flight guard, which only blocks cash. Two card charges against
    // the same items is the same double payment as card-and-cash.
    heldIntentRows = [HELD]
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'card' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(409)
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })

  it('an intent settles its OWN held items', async () => {
    /**
     * The exemption that makes the feature work at all. The charge that placed the hold is the one
     * that comes back to settle against it; without this it would be refused by its own hold.
     */
    heldIntentRows = [HELD]
    intentByIdRow = { allocation_ids: ['alloc-1'], status: 'launched' }
    const res = await POST(
      req({ allocation_ids: ['alloc-1'], method: 'card', settling_intent_id: 'intent-1' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(200)
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(1)
  })

  it("but NOT another intent's held items", async () => {
    /**
     * The exemption is containment, not merely "an intent was named". An intent holding alloc-1
     * must not be able to settle alloc-1 AND alloc-2 while a different intent holds alloc-2 --
     * that is one payment settling another payment's items.
     */
    heldIntentRows = [{ allocation_ids: ['alloc-1', 'alloc-2'], status: 'launched' }]
    intentByIdRow = { allocation_ids: ['alloc-1'], status: 'launched' }
    const res = await POST(
      req({ allocation_ids: ['alloc-1', 'alloc-2'], method: 'card', settling_intent_id: 'intent-1' }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    expect(res.status).toBe(409)
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })

  it('a hold read that FAILS refuses rather than proceeding', async () => {
    /**
     * FAIL CLOSED. Not being able to read the hold is not permission to take the money again -- the
     * failure mode this replaced returned an empty list on error, which reads as "nobody holds
     * these" and settles.
     */
    intentsReadError = { message: 'connection reset' }
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('HOLD_CHECK_FAILED')
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(0)
  })

  it('settles normally when nothing is held', async () => {
    // The positive control. A guard suite made only of refusals cannot tell a working guard from a
    // route that refuses everything.
    heldIntentRows = []
    const res = await POST(req({ allocation_ids: ['alloc-1'], method: 'cash' }), {
      params: Promise.resolve({ tabId: TAB_ID }),
    })
    expect(res.status).toBe(200)
    expect(rpcCalls.filter((c) => c.name === 'settle_order_line_allocations')).toHaveLength(1)
  })
})
