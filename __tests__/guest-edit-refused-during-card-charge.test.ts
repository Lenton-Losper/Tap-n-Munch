/**
 * A GUEST MAY NOT EDIT AN ORDER WHILE A CARD IS BEING CHARGED FOR IT (Sprint 2026-09-29 brief, task 5).
 *
 * prepare-payment leaves payment_status 'pending' -- a status the editor allows -- and stamps
 * pending_charge_cents / pending_charge_at for the reader. An edit then changed what the order was
 * worth while the card was charged the old figure, and the settlement marked the added items paid
 * at it. Two layers refuse it now, and both are pinned here:
 *
 *   1. the READ-side gate (editRefusalReason -> isChargeInFlight), which answers before anything is
 *      written, on POST (open the editor) and PATCH (commit);
 *   2. the DATABASE's own refusal (FTINF from orders_refuse_edit_during_charge, 20260929120000),
 *      for a charge prepared between the route's read and its write. The route must turn that into
 *      the same `payment_in_flight` refusal, not a 500 and not a success.
 *
 * The database half is proven in two real Postgres sessions by
 * supabase/tests/charge-edit-race.test.sh; this file pins the route's side of the contract.
 */
import { PATCH, POST } from '@/app/api/guest/orders/[orderId]/edit/route'
import {
  EDIT_COPY,
  PAYMENT_IN_FLIGHT_WINDOW_MS,
  editRefusalReason,
  isChargeInFlight,
} from '@/lib/orders/edit-lock'

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => `uuid-${id}`,
}))

type WriteCall = { table: string; patch: Record<string, unknown> }

let orderRow: Record<string, unknown>
let writes: WriteCall[]
/** What the conditional UPDATE returns: a row, nothing (lost), or a database error. */
let writeOutcome: { data: Record<string, unknown> | null; error: { code: string; message: string } | null }

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            maybeSingle: async () => ({ data: table === 'orders' ? orderRow : null, error: null }),
          }
          return b
        },
        update: (patch: Record<string, unknown>) => {
          writes.push({ table, patch })
          const b: Record<string, unknown> = {
            eq: () => b,
            is: () => b,
            in: () => b,
            select: () => ({
              maybeSingle: async () =>
                writeOutcome.error
                  ? { data: null, error: writeOutcome.error }
                  : { data: writeOutcome.data ? { ...writeOutcome.data, ...patch } : null, error: null },
            }),
          }
          return b
        },
      }
    },
  }),
}))

const SESSION = 'sess_owner'
const LINES = [
  { menuItemId: 'm-burger', name: 'Burger', quantity: 2, unitPrice: 100, subtotal: 173.91, tax: 26.09, total: 200, taxRatePercentage: 15, taxInclusive: true },
  { menuItemId: 'm-coke', name: 'Coke', quantity: 1, unitPrice: 25, subtotal: 21.74, tax: 3.26, total: 25, taxRatePercentage: 15, taxInclusive: true },
]

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    restaurant_id: 'uuid-rest-1',
    tab_id: null,
    session_id: SESSION,
    member_session_id: null,
    status: 'accepted',
    payment_status: 'pending',
    payment_checkout_url: null,
    items: LINES,
    subtotal: 195.65,
    tax: 29.35,
    total: 225,
    order_instructions: null,
    edit_lock_token: 'my-token',
    edit_lock_session_id: SESSION,
    edit_lock_expires_at: new Date(Date.now() + 120_000).toISOString(),
    customer_edit_count: 0,
    edit_history: [],
    total_before_edit: null,
    pending_charge_cents: null,
    pending_charge_at: null,
    ...overrides,
  }
}

const inFlight = () => ({
  pending_charge_cents: 22500,
  pending_charge_at: new Date(Date.now() - 30_000).toISOString(),
})

async function call(
  handler: (req: Request, ctx: { params: Promise<{ orderId: string }> }) => Promise<Response>,
  method: string,
  body: Record<string, unknown>,
) {
  const req = new Request('http://localhost/api/guest/orders/order-1/edit', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: 'rest-1', sessionIds: [SESSION], ...body }),
  })
  const res = await handler(req, { params: Promise.resolve({ orderId: 'order-1' }) })
  return { status: res.status, body: await res.json() }
}

const REDUCE = { lockToken: 'my-token', keep: [{ index: 0, quantity: 1 }, { index: 1, quantity: 1 }] }

beforeEach(() => {
  orderRow = order()
  writes = []
  writeOutcome = { data: { id: 'order-1', status: 'accepted', total: 125, requires_reacceptance: false }, error: null }
})

describe('the in-flight predicate', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')

  it('is in flight inside the window and not after it', () => {
    const at = (msAgo: number) => new Date(now - msAgo).toISOString()
    expect(isChargeInFlight({ pending_charge_cents: 100, pending_charge_at: at(1_000) }, now)).toBe(true)
    expect(isChargeInFlight({ pending_charge_cents: 100, pending_charge_at: at(PAYMENT_IN_FLIGHT_WINDOW_MS - 1) }, now)).toBe(true)
    expect(isChargeInFlight({ pending_charge_cents: 100, pending_charge_at: at(PAYMENT_IN_FLIGHT_WINDOW_MS) }, now)).toBe(false)
  })

  it('is not in flight when no charge is prepared', () => {
    expect(isChargeInFlight({ pending_charge_cents: null, pending_charge_at: null }, now)).toBe(false)
    expect(isChargeInFlight({}, now)).toBe(false)
  })

  it('fails CLOSED on a prepared charge with no readable timestamp', () => {
    expect(isChargeInFlight({ pending_charge_cents: 100, pending_charge_at: null }, now)).toBe(true)
    expect(isChargeInFlight({ pending_charge_cents: 100, pending_charge_at: 'garbage' }, now)).toBe(true)
  })

  it('is the gate: a pending order with a card charge in flight is refused payment_in_flight', () => {
    const row = { status: 'accepted', payment_status: 'pending', pending_charge_cents: 100, pending_charge_at: new Date(now).toISOString() }
    expect(editRefusalReason(row, { sessionIds: [SESSION], nowMs: now })).toBe('payment_in_flight')
    expect(editRefusalReason({ ...row, pending_charge_cents: null }, { sessionIds: [SESSION], nowMs: now })).toBeNull()
  })
})

describe('the route refuses while a card is being charged', () => {
  it('POST: will not even open the editor, and writes nothing', async () => {
    orderRow = order({ ...inFlight(), edit_lock_token: null, edit_lock_session_id: null, edit_lock_expires_at: null })
    const { status, body } = await call(POST, 'POST', {})
    expect(status).toBe(409)
    expect(body.reason).toBe('payment_in_flight')
    expect(body.error).toBe(EDIT_COPY.paymentInFlight)
    expect(writes).toHaveLength(0)
  })

  it('PATCH: refuses the commit, and writes nothing', async () => {
    orderRow = order(inFlight())
    const { status, body } = await call(PATCH, 'PATCH', REDUCE)
    expect(status).toBe(409)
    expect(body.reason).toBe('payment_in_flight')
    expect(writes).toHaveLength(0)
  })

  it('PATCH: a charge prepared after the read -- the database refuses (FTINF) and the customer is told so', async () => {
    orderRow = order()
    writeOutcome = { data: null, error: { code: 'FTINF', message: 'order has a card charge in flight' } }
    const { status, body } = await call(PATCH, 'PATCH', REDUCE)
    expect(writes).toHaveLength(1)
    expect(status).toBe(409)
    expect(body.reason).toBe('payment_in_flight')
    expect(body.error).toBe(EDIT_COPY.paymentInFlight)
  })

  it('negative control: once the window has passed the edit is allowed', async () => {
    orderRow = order({
      pending_charge_cents: 22500,
      pending_charge_at: new Date(Date.now() - PAYMENT_IN_FLIGHT_WINDOW_MS - 1_000).toISOString(),
    })
    const { status, body } = await call(PATCH, 'PATCH', REDUCE)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('PATCH: an order with fulfilment lines -- the database refuses (FTLIN) and the edit is not_editable_status', async () => {
    // 20260929120400: a lined order's items are never rewritten, so an addition can never exist
    // without a line (stations would not see it; the item-ledger paid check could not count it).
    writeOutcome = { data: null, error: { code: 'FTLIN', message: 'order has fulfilment lines' } }
    const { status, body } = await call(PATCH, 'PATCH', REDUCE)
    expect(status).toBe(409)
    expect(body.reason).toBe('not_editable_status')
    expect(body.error).toBe(EDIT_COPY.notEditable)
  })

  it('negative control: a different database error is still a 500, not a disguised refusal', async () => {
    writeOutcome = { data: null, error: { code: '23505', message: 'something else' } }
    const { status } = await call(PATCH, 'PATCH', REDUCE)
    expect(status).toBe(500)
  })
})
