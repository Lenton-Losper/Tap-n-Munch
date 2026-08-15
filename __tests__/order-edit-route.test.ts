/**
 * PATCH/POST/DELETE /api/guest/orders/[orderId]/edit — the conditional writes.
 *
 * These assert the WHERE clauses, not the happy path, because the WHERE clauses are the
 * feature. "Staff wins" is not a rule written anywhere in the customer route; it is the
 * consequence of the commit being conditioned on a token that the staff status route nulls.
 * If that filter ever stops being sent the route still returns 200 on the happy path, still
 * typechecks, and silently lets a customer change an order the kitchen has started.
 *
 * Hermetic: supabase and the restaurant resolver are mocked; no HTTP, no database.
 */
import { DELETE, PATCH, POST } from '@/app/api/guest/orders/[orderId]/edit/route'

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => `uuid-${id}`,
}))

type WriteCall = {
  table: string
  patch: Record<string, unknown>
  filters: Array<[string, unknown]>
}

let orderRow: Record<string, unknown> | null
let requestRow: Record<string, unknown> | null
let writes: WriteCall[]
/** null models a lost conditional write — the row moved under us. */
let writeResult: Record<string, unknown> | null
/**
 * Successive `orders` reads, when a test needs them to DIFFER. That is the whole shape of the
 * race being modelled: the route loads an editable order, its conditional write matches nothing
 * because staff got there first, and it re-reads to find out what happened. One fixed row cannot
 * express that, and a test that cannot express it cannot check the message the customer is given.
 */
let orderReadSequence: Array<Record<string, unknown> | null> | null

function makeSupabaseMock() {
  return {
    from(table: string) {
      return {
        select: () => {
          const readBuilder: Record<string, unknown> = {
            eq: () => readBuilder,
            maybeSingle: async () => {
              if (table === 'order_requests') return { data: requestRow, error: null }
              if (table !== 'orders') return { data: null, error: null }
              if (orderReadSequence && orderReadSequence.length > 0) {
                // Last entry repeats, so a route that reads once more than the test anticipated
                // gets the post-race row rather than undefined.
                const next =
                  orderReadSequence.length > 1 ? orderReadSequence.shift() : orderReadSequence[0]
                return { data: next ?? null, error: null }
              }
              return { data: orderRow, error: null }
            },
          }
          return readBuilder
        },
        update: (patch: Record<string, unknown>) => {
          const call: WriteCall = { table, patch, filters: [] }
          writes.push(call)
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) {
              call.filters.push([column, value])
              return builder
            },
            is(column: string, value: unknown) {
              call.filters.push([`is:${column}`, value])
              return builder
            },
            in(column: string, value: unknown) {
              call.filters.push([`in:${column}`, value])
              return builder
            },
            select() {
              return {
                maybeSingle: async () => ({
                  // A returning UPDATE hands back the row AS WRITTEN. Echoing the patch matters
                  // here: the acquire handler reads the new token out of this response, and a
                  // mock that returned a fixed row would make a real regression invisible.
                  data: writeResult ? { ...writeResult, ...call.patch } : null,
                  error: null,
                }),
              }
            },
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

const SESSION = 'sess_owner'
const LINES = [
  { name: 'Burger', quantity: 2, unitPrice: 100, subtotal: 173.91, tax: 26.09, total: 200, taxRatePercentage: 15, taxInclusive: true },
  { name: 'Coke', quantity: 1, unitPrice: 25, subtotal: 21.74, tax: 3.26, total: 25, taxRatePercentage: 15, taxInclusive: true },
]

function baseOrder(overrides: Record<string, unknown> = {}) {
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
    order_instructions: 'no onions',
    edit_lock_token: null,
    edit_lock_session_id: null,
    edit_lock_expires_at: null,
    customer_edit_count: 0,
    edit_history: [],
    total_before_edit: null,
    ...overrides,
  }
}

function liveLock(token: string, session = SESSION) {
  return {
    edit_lock_token: token,
    edit_lock_session_id: session,
    edit_lock_expires_at: new Date(Date.now() + 120_000).toISOString(),
  }
}

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

beforeEach(() => {
  orderRow = baseOrder()
  requestRow = null
  orderReadSequence = null
  writes = []
  writeResult = { id: 'order-1', status: 'accepted', total: 225, requires_reacceptance: false }
})

describe('acquiring the lock is a compare-and-set, not a claim of intent', () => {
  it('claims a free lock with `is null`, because `.eq` never matches NULL', async () => {
    const { status, body } = await call(POST, 'POST', {})

    expect(status).toBe(200)
    expect(typeof body.lockToken).toBe('string')
    expect(writes[0].filters).toContainEqual(['is:edit_lock_token', null])
  })

  it('claims an EXPIRED lock against the exact token it observed', async () => {
    orderRow = baseOrder({
      edit_lock_token: 'stale-token',
      edit_lock_session_id: 'someone-else',
      edit_lock_expires_at: new Date(Date.now() - 1000).toISOString(),
    })

    await call(POST, 'POST', {})

    // Two customers both seeing the same expired token both try this; only one UPDATE can
    // match, because the winner replaces the token.
    expect(writes[0].filters).toContainEqual(['edit_lock_token', 'stale-token'])
  })

  /**
   * QRA-01. `edit_lock_session_id` is a `text` column, and isEditLockHeldByOther reads it back
   * as a scalar. The route once wrote `parsed.sessionIds` — an ARRAY — and PostgREST's
   * json_populate_record stores a JSON array into a text column as its JSON TEXT, so the row
   * came back holding `["a", "b"]`, which matches no id. The holder failed its own holder check
   * and EVERY commit was refused 409 locked_by_other.
   *
   * This asserts the SHAPE of the value written, which is the thing no existing test could see:
   * the Supabase mock does no type coercion, and every fixture supplies a scalar holder, so the
   * suite pinned the rule in edit-lock.ts and never observed what the route actually writes.
   *
   * Two-sided: restore `edit_lock_session_id: parsed.sessionIds` in the acquire and this test
   * fails on the toBe('string') line.
   */
  it('records a SCALAR holder, never the id array — a text column cannot hold a list', async () => {
    const { status } = await call(POST, 'POST', { sessionIds: [SESSION, 'sess_second_id'] })

    expect(status).toBe(200)
    const holder = writes[0].patch.edit_lock_session_id
    expect(Array.isArray(holder)).toBe(false)
    expect(typeof holder).toBe('string')
    // The PRIMARY id — the first the client sent. The read side matches it against every id the
    // client holds, so one is enough to identify the holder.
    expect(holder).toBe(SESSION)
  })

  it('re-asserts the status and payment gates inside the write, not only in the read', async () => {
    await call(POST, 'POST', {})

    expect(writes[0].filters).toContainEqual(['in:status', ['pending', 'accepted']])
    expect(writes[0].filters).toContainEqual(['in:payment_status', ['pending', 'cash_pending']])
  })

  it('refuses outright once the kitchen has the order, writing nothing', async () => {
    orderRow = baseOrder({ status: 'preparing' })

    const { status, body } = await call(POST, 'POST', {})

    expect(status).toBe(409)
    expect(body.reason).toBe('preparation_started')
    expect(writes).toHaveLength(0)
  })

  it('refuses while another session holds a live lock', async () => {
    orderRow = baseOrder(liveLock('theirs', 'sess_other'))

    const { status, body } = await call(POST, 'POST', {})

    expect(status).toBe(409)
    expect(body.reason).toBe('locked_by_other')
  })

  it('answers 404 for an order this session does not own, not 403', async () => {
    // A 403 would confirm that an order exists at an id the caller cannot otherwise see.
    orderRow = baseOrder({ session_id: 'sess_someone_else' })

    const { status } = await call(POST, 'POST', {})

    expect(status).toBe(404)
  })
})

describe('committing: the token in the WHERE clause is what makes staff win', () => {
  beforeEach(() => {
    orderRow = baseOrder(liveLock('my-token'))
  })

  it('conditions the write on the caller’s own token', async () => {
    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 0, quantity: 2 }] })

    // Staff moving the order to `preparing` nulls this column, so this filter matches zero
    // rows and the edit is refused. Remove this line and the feature silently breaks its
    // central ruling while every happy-path test stays green.
    expect(writes[0].filters).toContainEqual(['edit_lock_token', 'my-token'])
    expect(writes[0].filters).toContainEqual(['in:status', ['pending', 'accepted']])
  })

  it('refuses a token that is not the one on the row', async () => {
    const { status, body } = await call(PATCH, 'PATCH', {
      lockToken: 'not-my-token',
      keep: [{ index: 0, quantity: 2 }],
    })

    expect(status).toBe(409)
    expect(body.reason).toBe('lock_lost')
    expect(writes).toHaveLength(0)
  })

  it('refuses an EXPIRED token even though it is the right one', async () => {
    orderRow = baseOrder({
      edit_lock_token: 'my-token',
      edit_lock_session_id: SESSION,
      edit_lock_expires_at: new Date(Date.now() - 1).toISOString(),
    })

    const { status, body } = await call(PATCH, 'PATCH', {
      lockToken: 'my-token',
      keep: [{ index: 0, quantity: 2 }],
    })

    expect(status).toBe(409)
    expect(body.reason).toBe('lock_lost')
  })

  it('tells the customer the kitchen started when the write is lost to a staff transition', async () => {
    // The race, in order: the route loads an editable order holding our lock, its conditional
    // write matches nothing because the staff transition nulled the token, and the re-read finds
    // the order the kitchen now has.
    writeResult = null
    orderReadSequence = [
      baseOrder(liveLock('my-token')),
      baseOrder({ status: 'preparing', edit_lock_token: null }),
    ]

    const { status, body } = await call(PATCH, 'PATCH', {
      lockToken: 'my-token',
      keep: [{ index: 0, quantity: 2 }],
    })

    expect(status).toBe(409)
    expect(body.reason).toBe('preparation_started')
    expect(String(body.error)).toMatch(/kitchen/i)
  })
})

describe('what a committed edit writes', () => {
  beforeEach(() => {
    orderRow = baseOrder(liveLock('my-token'))
  })

  it('sends a total-changing edit back to review with the new figure', async () => {
    // Drop the Coke: 225 -> 200.
    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 0, quantity: 2 }] })

    const { patch } = writes[0]
    expect(patch.total).toBe(200)
    expect(patch.status).toBe('pending')
    expect(patch.requires_reacceptance).toBe(true)
    expect(patch.total_before_edit).toBe(225)
  })

  it('does NOT send a notes-only edit back to review', async () => {
    await call(PATCH, 'PATCH', { lockToken: 'my-token', orderInstructions: 'extra napkins' })

    const { patch } = writes[0]
    expect(patch).not.toHaveProperty('status')
    expect(patch.requires_reacceptance).toBe(false)
    expect(patch).not.toHaveProperty('total_before_edit')
    expect(patch.order_instructions).toBe('extra napkins')
  })

  it('spends the lock, so the dashboard stops saying an edit is open', async () => {
    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 0, quantity: 2 }] })

    expect(writes[0].patch.edit_lock_token).toBeNull()
    expect(writes[0].patch.edit_lock_expires_at).toBeNull()
  })

  it('records the before/after and the previous items in edit_history', async () => {
    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 0, quantity: 2 }] })

    const history = writes[0].patch.edit_history as Array<Record<string, unknown>>
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ previous_total: 225, new_total: 200, items_changed: true })
    expect(history[0].previous_items).toEqual(LINES)
    expect(writes[0].patch.customer_edit_count).toBe(1)
  })

  it('refuses an edit that would empty the order', async () => {
    const { status } = await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [] })
    expect(status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('refuses a request that changes nothing', async () => {
    const { status } = await call(PATCH, 'PATCH', { lockToken: 'my-token', orderInstructions: 'no onions' })
    expect(status).toBe(400)
    expect(writes).toHaveLength(0)
  })
})

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    restaurant_id: 'uuid-rest-1',
    tab_id: null,
    session_id: SESSION,
    member_session_id: null,
    status: 'waiting_review',
    order_instructions: null,
    items: LINES,
    subtotal: 195.65,
    tax: 29.35,
    total: 225,
    items_customer: null,
    items_reviewed: null,
    customer_edit_count: 0,
    edit_history: [],
    total_before_edit: null,
    ...liveLock('my-token'),
    ...overrides,
  }
}

describe('the pre-Accept surface writes to its own columns', () => {
  beforeEach(() => {
    orderRow = null
    requestRow = baseRequest()
    writeResult = { id: 'req-1', status: 'waiting_review', total: 200, requires_reacceptance: false }
  })

  it('never mutates the original submission, which the table declares immutable', async () => {
    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 0, quantity: 2 }] })

    const { patch, table } = writes[0]
    expect(table).toBe('order_requests')
    expect(patch).not.toHaveProperty('items')
    expect(patch).not.toHaveProperty('total')
    expect(patch.items_customer).toHaveLength(1)
    expect(patch.total_customer).toBe(200)
  })

  it('discards a stale staff review rather than letting Accept charge from it', async () => {
    requestRow = baseRequest({ items_reviewed: LINES, total_reviewed: 225 })

    await call(PATCH, 'PATCH', { lockToken: 'my-token', keep: [{ index: 1, quantity: 1 }] })

    const { patch } = writes[0]
    // Accept reads items_reviewed FIRST. Leaving it would silently discard this edit and
    // charge the customer for the item they just removed.
    expect(patch.items_reviewed).toBeNull()
    expect(patch.total_reviewed).toBeNull()
    expect(patch.requires_reacceptance).toBe(true)
    const history = patch.edit_history as Array<Record<string, unknown>>
    expect(history[0].discarded_staff_review).toEqual(LINES)
  })
})

describe('releasing', () => {
  it('releases only against the caller’s own token', async () => {
    orderRow = baseOrder(liveLock('my-token'))

    const { status } = await call(DELETE, 'DELETE', { lockToken: 'my-token' })

    expect(status).toBe(200)
    expect(writes[0].filters).toContainEqual(['edit_lock_token', 'my-token'])
    expect(writes[0].patch.edit_lock_token).toBeNull()
  })

  it('is not an error when the lock has already gone', async () => {
    orderRow = baseOrder(liveLock('my-token'))
    writeResult = null

    const { status, body } = await call(DELETE, 'DELETE', { lockToken: 'my-token' })

    expect(status).toBe(200)
    expect(body.released).toBe(false)
  })
})
