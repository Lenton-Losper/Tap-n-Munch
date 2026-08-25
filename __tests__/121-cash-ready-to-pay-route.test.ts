/**
 * #121 — the cash "Ready to Pay" button, moved off the browser anon client onto a service-role
 * route.
 *
 * WHAT THE DEFECT WAS, and why a test on the OLD code could never have caught it. The button did
 *
 *     supabase.from('orders').update({ customer_ready_to_pay: true }).eq('id', orderId)
 *
 * with the BROWSER anon key. The only anon UPDATE policy on `orders` is
 * `WITH CHECK (status = 'ready_for_terminal')`, evaluated against the resulting row, and a cash
 * order is never in that status. Production, read-only, 2026-08-25: 490 cash orders, 0 ever
 * flagged. On staging the same press produced NO ERROR — RLS filtered the row, PostgREST reported
 * success, and the component took its success path. The failure lived entirely in the DATABASE's
 * policy, which is why no unit test existed and no unit test could have existed.
 *
 * SO THIS SUITE DOES NOT TRY TO PROVE THE OLD BUG. It pins the NEW seam, which is the part that
 * is now testable: a route that authorises, refuses and writes in process.
 *
 * FAILS WITHOUT THE FIX: `app/api/orders/[orderId]/ready-to-pay-cash/route.ts` does not exist at
 * `ceea943`, so every case here errors at import.
 *
 * THE LOAD-BEARING CASES, stated so a future reader can check the suite still has teeth:
 *   - a caller holding NONE of the order's session ids is REFUSED (403). Delete the `owned` check
 *     in the route and this is the assertion that goes red.
 *   - a NON-CASH order is refused even for the rightful owner. This is the one that stops the
 *     route being a general-purpose "flag any order" endpoint, which the old anon write at least
 *     could not be.
 *   - `status` is NEVER written. The card sibling moves status to `ready_for_terminal`; copying
 *     that here would put a cash order in the card queue.
 */
import { POST } from '@/app/api/orders/[orderId]/ready-to-pay-cash/route'

const ORDER_ID = '5fe2cd4e-37a9-489a-9a55-4b1d44df2b95'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '11111111-2222-3333-4444-555555555555'

/** The two ids the app mints, in the two formats it mints them in. */
const LOCAL_SESSION = 'sess_9a1c4f10-0000-4000-8000-000000000001'
const TAB_SESSION = 'session_1754900000000_mine'
const STRANGER_SESSION = 'sess_deadbeef-0000-4000-8000-00000000ffff'

type Row = Record<string, unknown>

let orderRow: Row | null
let updatePayload: Row | null
let updateFilters: Array<[string, unknown]>
let selectedColumns: string
let tokenValidation: {
  valid: boolean
  reason?: string
  tabId?: string
  tableId?: string
  restaurantId?: string
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select(columns: string) {
          selectedColumns = columns
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: orderRow, error: null }),
            }),
          }
        },
        update(payload: Row) {
          updatePayload = payload
          const chain = {
            eq(column: string, value: unknown) {
              updateFilters.push([column, value])
              return chain
            },
            select: () => ({
              maybeSingle: async () =>
                orderRow ? { data: { id: ORDER_ID }, error: null } : { data: null, error: null },
            }),
          }
          return chain
        },
      }
    },
  }),
}))

jest.mock('@/lib/session-token', () => ({
  validateSessionToken: async () => tokenValidation,
}))

function req(body: Row, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/ready-to-pay-cash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ orderId: ORDER_ID })

function cashOrder(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    restaurant_id: RESTAURANT_ID,
    tab_id: null,
    session_id: TAB_SESSION,
    member_session_id: null,
    status: 'preparing',
    payment_status: 'cash_pending',
    payment_method: 'cash',
    payment_channel: 'cash',
    customer_ready_to_pay: false,
    ...overrides,
  }
}

beforeEach(() => {
  orderRow = cashOrder()
  updatePayload = null
  updateFilters = []
  selectedColumns = ''
  // Default: NO valid dining token. Forces the session-id path, which is the one kiosk and
  // non-tab guests actually take.
  tokenValidation = { valid: false, reason: 'Session not found' }
})

describe('#121 POST /api/orders/[orderId]/ready-to-pay-cash — the write lands', () => {
  it('flags a cash order for a caller holding one of its session ids', async () => {
    const res = await POST(req({ session_ids: [LOCAL_SESSION, TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true, alreadyNotified: false })
    expect(updatePayload).toEqual({ customer_ready_to_pay: true })
  })

  it('writes ONLY customer_ready_to_pay — never status', async () => {
    await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(Object.keys(updatePayload ?? {})).toEqual(['customer_ready_to_pay'])
    // The card sibling sets 'ready_for_terminal'. A cash order in that state joins the card queue.
    expect(JSON.stringify(updatePayload)).not.toContain('ready_for_terminal')
    expect(updateFilters).toEqual([['id', ORDER_ID]])
  })

  it('matches member_session_id too, not just session_id', async () => {
    orderRow = cashOrder({ session_id: STRANGER_SESSION, member_session_id: TAB_SESSION })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
  })

  it('accepts the singular session_id body key as well as the plural', async () => {
    const res = await POST(req({ session_id: TAB_SESSION }), { params })
    expect(res.status).toBe(200)
  })

  it('reads member_session_id in its projection — a column it never selects is a column it cannot match on', async () => {
    await POST(req({ session_ids: [TAB_SESSION] }), { params })
    for (const column of [
      'session_id',
      'member_session_id',
      'payment_status',
      'payment_method',
      'payment_channel',
      'status',
      'customer_ready_to_pay',
      'tab_id',
    ]) {
      expect(selectedColumns).toContain(column)
    }
  })
})

describe('#121 ownership', () => {
  it('REFUSES a caller holding none of the order’s ids', async () => {
    const res = await POST(req({ session_ids: [STRANGER_SESSION] }), { params })
    expect(res.status).toBe(403)
    expect(updatePayload).toBeNull()
  })

  it('REFUSES a caller holding no ids at all', async () => {
    const res = await POST(req({}), { params })
    expect(res.status).toBe(403)
    expect(updatePayload).toBeNull()
  })

  it('accepts a valid dining token bound to the order’s restaurant, with no session id at all', async () => {
    tokenValidation = { valid: true, restaurantId: RESTAURANT_ID }
    const res = await POST(req({}, { 'x-session-token': 'tok' }), { params })
    expect(res.status).toBe(200)
  })

  it('REFUSES a valid token issued for a DIFFERENT restaurant', async () => {
    tokenValidation = { valid: true, restaurantId: 'ffffffff-0000-4000-8000-000000000000' }
    const res = await POST(req({}, { 'x-session-token': 'tok' }), { params })
    expect(res.status).toBe(403)
    expect(updatePayload).toBeNull()
  })

  it('REFUSES a valid token for the right restaurant but a DIFFERENT tab', async () => {
    orderRow = cashOrder({ tab_id: TAB_ID, session_id: STRANGER_SESSION })
    tokenValidation = {
      valid: true,
      restaurantId: RESTAURANT_ID,
      tabId: '00000000-9999-4000-8000-000000000000',
    }
    const res = await POST(req({}, { 'x-session-token': 'tok' }), { params })
    expect(res.status).toBe(403)
  })
})

describe('#121 eligibility — the route is not a flag-any-order endpoint', () => {
  it('REFUSES a card order even for its rightful owner', async () => {
    orderRow = cashOrder({
      payment_method: 'card',
      payment_channel: 'card',
      payment_status: 'pending',
    })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('not a cash order'),
    })
    expect(updatePayload).toBeNull()
  })

  it('REFUSES an order that is already paid', async () => {
    orderRow = cashOrder({ payment_status: 'paid' })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(409)
    expect(updatePayload).toBeNull()
  })

  it('REFUSES a completed order', async () => {
    orderRow = cashOrder({ status: 'completed' })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(409)
    expect(updatePayload).toBeNull()
  })

  it('ALLOWS status "new" — the column default, and not in ACTIVE_ORDER_STATUSES', async () => {
    // The guard asks isTerminalOrderStatus, not !isActiveOrderStatus, precisely so a status the
    // display vocabulary has never heard of does not refuse a customer waiting to pay.
    orderRow = cashOrder({ status: 'new' })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
  })

  it('treats a card order that fell back to cash_pending as cash', async () => {
    // app/api/payments/cancel-terminal/route.ts:96 writes this when a card attempt is abandoned.
    orderRow = cashOrder({ payment_method: 'card', payment_channel: 'card', payment_status: 'cash_pending' })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
  })
})

describe('#121 idempotency', () => {
  it('a second press is a success, not an error', async () => {
    orderRow = cashOrder({ customer_ready_to_pay: true })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ alreadyNotified: true })
    expect(updatePayload).toBeNull()
  })

  it('an already-flagged order that has since been PAID still answers success, not "already paid"', async () => {
    // The customer's own earlier press is what produced this state. Telling them it failed would
    // be an error message about their own success.
    orderRow = cashOrder({ customer_ready_to_pay: true, payment_status: 'paid' })
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ alreadyNotified: true })
  })
})

describe('#121 missing order', () => {
  it('404s rather than reporting a success nobody will see', async () => {
    orderRow = null
    const res = await POST(req({ session_ids: [TAB_SESSION] }), { params })
    expect(res.status).toBe(404)
    expect(updatePayload).toBeNull()
  })
})
