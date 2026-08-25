/**
 * #301 — AN ADDITION MAY NOT LAND ON A TAB THAT IS NO LONGER OPEN.
 *
 * #301 filed two findings. Both are closed on this branch, and NEITHER is closed by the guard the
 * issue proposed, which is the reason this file exists.
 *
 *  1. "Additions bypass the ready_to_pay guard." They did, at `64937fd`, because
 *     `applyEditAdditions` reads no tab status and the edit route read `tab_id` only AFTER the
 *     commit, to recompute the tab total. What closed it was #302: the edit route now calls
 *     `requireSessionToken` for any order carrying a `tab_id`, and `validateSessionToken` refuses
 *     a tab whose `status` is not `open` (`lib/session-token.ts`). The addition never reaches
 *     `applyEditAdditions`.
 *
 *  2. "That guard is unreachable anyway." #303 acted on that: the bespoke 400 in
 *     `POST /api/orders` and its two sentences are gone, and the check itself stays for the
 *     sub-second race. See the docblock at `app/api/orders/route.ts` for the ruling.
 *
 * SO THE GUARD THAT ACTUALLY PROTECTS BOTH ROUTES IS ONE LINE IN `validateSessionToken`, AND
 * NOTHING PINNED IT. `__tests__/order-edit-route.test.ts` cannot: it mocks `@/lib/session-token`
 * wholesale so a test about what an edit WRITES does not have to forge a token — correct for that
 * file, and it means the tab-status refusal is stubbed out of existence there. No other suite
 * exercises the real `validateSessionToken` at all.
 *
 * That is the gap this file closes. It mocks Supabase and NOT the session token, so the real
 * `requireSessionToken` -> real `validateSessionToken` -> real edit route chain runs end to end,
 * and the tab's `status` is the only thing that varies between the two halves.
 *
 * THE OPEN-TAB CASE IS A POSITIVE CONTROL, not a courtesy. Without it a green refusal case proves
 * only that the request failed, which it would also do if the fixture were malformed, the lock
 * were wrong, or the route 404'd on the order. The control shows the same request reaching the
 * write when the tab is open, so the refusal is attributable to the status and to nothing else.
 *
 * Hermetic: no HTTP, no database.
 */
import { PATCH } from '@/app/api/guest/orders/[orderId]/edit/route'

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => `uuid-${id}`,
}))

/**
 * DELIBERATELY NOT MOCKED: `@/lib/session-token`. That module is the subject. Mocking it here
 * would reproduce exactly the blind spot this file exists to remove.
 */

/** The addition path's two external calls, mocked so this file stays about the tab's status. */
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true, unavailable: [] }),
}))
jest.mock('@/lib/orders/calculate-order-pricing', () => ({
  calculateOrderPricing: async () => ({
    items: [
      { menuItemId: 'm-coke', name: 'Coke', quantity: 1, unitPrice: 20, subtotal: 17.39, tax: 2.61, total: 20 },
    ],
    subtotal: 17.39,
    tax: 2.61,
    total: 20,
    warnings: [] as string[],
  }),
}))

const TAB_ID = 'tab-1'
const TABLE_ID = 'table-1'
const RESTAURANT_UUID = 'uuid-rest-1'
const SESSION = 'sess_owner'
const TOKEN = 'tab-session-token'

/** The one variable. Everything else about the fixture is identical between the two cases. */
let tabStatus: string

type WriteCall = { table: string; patch: Record<string, unknown> }
let writes: WriteCall[]

const LINES = [
  { menuItemId: 'm-burger', name: 'Burger', quantity: 2, unitPrice: 100, subtotal: 173.91, tax: 26.09, total: 200, taxRatePercentage: 15, taxInclusive: true },
]

function orderRow() {
  return {
    id: 'order-1',
    restaurant_id: RESTAURANT_UUID,
    tab_id: TAB_ID,
    session_id: SESSION,
    member_session_id: null,
    status: 'accepted',
    payment_status: 'pending',
    payment_checkout_url: null,
    items: LINES,
    subtotal: 173.91,
    tax: 26.09,
    total: 200,
    order_instructions: '',
    edit_lock_token: 'my-token',
    edit_lock_session_id: SESSION,
    edit_lock_expires_at: new Date(Date.now() + 120_000).toISOString(),
    customer_edit_count: 0,
    customer_edited_at: null,
    edit_history: [],
    total_before_edit: null,
  }
}

/**
 * The session row `validateSessionToken` reads. `tabs!inner (status)` and
 * `restaurant_tables!inner (current_session_version)` arrive as nested relations — modelled as
 * arrays because that is the shape the function already defends against (`Array.isArray(...)`).
 */
function sessionRow() {
  return {
    id: 'cs-1',
    tab_id: TAB_ID,
    table_id: TABLE_ID,
    restaurant_id: RESTAURANT_UUID,
    session_version: 3,
    active: true,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    tabs: [{ status: tabStatus }],
    restaurant_tables: [{ current_session_version: 3 }],
  }
}

function makeSupabaseMock() {
  return {
    from(table: string) {
      return {
        select: () => {
          const readBuilder: Record<string, unknown> = {
            eq: () => readBuilder,
            in: () => readBuilder,
            is: () => readBuilder,
            // validateSessionToken's terminal call.
            single: async () => {
              if (table === 'customer_sessions') return { data: sessionRow(), error: null }
              return { data: null, error: null }
            },
            maybeSingle: async () => {
              if (table === 'orders') return { data: orderRow(), error: null }
              if (table === 'order_requests') return { data: null, error: null }
              return { data: null, error: null }
            },
            // The post-commit tab-total recompute reads a LIST of the tab's orders.
            then: undefined,
          }
          return readBuilder
        },
        update: (patch: Record<string, unknown>) => {
          writes.push({ table, patch })
          const builder: Record<string, unknown> = {
            eq: () => builder,
            is: () => builder,
            in: () => builder,
            select: () => ({
              maybeSingle: async () => ({
                data: { id: 'order-1', status: 'pending', total: 220, ...patch },
                error: null,
              }),
            }),
          }
          return builder
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

async function addAnItem() {
  const req = new Request('http://localhost/api/guest/orders/order-1/edit', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-session-token': TOKEN },
    body: JSON.stringify({
      restaurantId: 'rest-1',
      sessionIds: [SESSION],
      lockToken: 'my-token',
      add: [{ menuItemId: 'm-coke', quantity: 1 }],
    }),
  })
  const res = await PATCH(req, { params: Promise.resolve({ orderId: 'order-1' }) })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  writes = []
  tabStatus = 'open'
})

describe('#301 — an addition and the tab it would land on', () => {
  /**
   * POSITIVE CONTROL. Same request, same fixture, `status: 'open'`. If this ever stops reaching
   * the write, the refusal case below stops being evidence about the tab's status and the whole
   * file is measuring nothing.
   */
  it('CONTROL: reaches the write when the tab is open', async () => {
    tabStatus = 'open'

    const { status } = await addAnItem()

    expect(status).toBe(200)
    const orderWrites = writes.filter((w) => w.table === 'orders')
    expect(orderWrites.length).toBeGreaterThan(0)
    // The addition was actually priced in, not merely accepted: 200 + the mocked 20.
    expect(orderWrites[0].patch.total).toBe(220)
  })

  it('refuses the addition when the tab is ready_to_pay, and writes nothing', async () => {
    tabStatus = 'ready_to_pay'

    const { status } = await addAnItem()

    expect(status).toBe(410)
    // The whole point of #301: not merely a non-200, but no mutation of the order at all.
    expect(writes.filter((w) => w.table === 'orders')).toHaveLength(0)
  })

  /**
   * `ready_to_pay` is not special-cased anywhere — `validateSessionToken` requires `open`, so
   * every other terminal status is refused by the same line. Asserted so a future change that
   * enumerates statuses instead of requiring `open` cannot pass this file by handling one name.
   */
  it.each(['settled', 'closed', 'cancelled'])(
    'refuses the addition when the tab is %s, and writes nothing',
    async (status) => {
      tabStatus = status

      const res = await addAnItem()

      expect(res.status).toBe(410)
      expect(writes.filter((w) => w.table === 'orders')).toHaveLength(0)
    },
  )
})
