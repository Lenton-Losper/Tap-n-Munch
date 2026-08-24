import { NextRequest } from 'next/server'
import { projectTablemateOrder, TABLEMATE_ALLOWLIST } from '@/lib/guest-orders/tablemate-projection'

/**
 * #279 — A TABLE NUMBER SCOPES THIS ROUTE. IT NEVER AUTHORISES IT.
 *
 * The table number is printed on a stand in a public room and the restaurant id is in the QR link,
 * so both inputs to this route were public. Measured on production 2026-08-22 before the fix: the
 * ROWS path already failed closed with no session and returned nothing — but `countOnly=1` was
 * exempt from that guard and returned a live count. The leak was EXISTENCE ("someone at table 1 has
 * an open order right now"), not the order itself. Small, and still a disclosure nobody authorised.
 *
 * BOTH DIRECTIONS, because the two ways to get this wrong are opposite:
 *   too OPEN   — countOnly keeps answering without a session (today's leak)
 *   too CLOSED — a customer with a session stops seeing their OWN order, which loses them the
 *                resume-payment prompt mid-checkout
 *
 * countOnly IS ASSERTED SEPARATELY from the rows path, because it was the rows path being correct
 * that hid this: a suite that only checked rows would have been green throughout.
 */
const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const SESSION = 'sess-abc-123'

type Row = Record<string, unknown>

const fetchGuestActiveTableOrders = jest.fn(async () => ({
  orders: [
    {
      id: 'order-1',
      order_number: 42,
      status: 'pending',
      payment_status: 'pending',
      payment_channel: 'hosted',
      placed_at: '2026-08-22T10:00:00Z',
      total: 85,
      table_number: 1,
      is_closed: false,
      surface: 'orders',
      edit_lock_held: false,
      // Everything below must NOT survive the projection.
      session_id: SESSION,
      member_session_id: 'member-xyz',
      customer_name: 'A Real Person',
      items: [{ name: 'Flat white', quantity: 1 }],
      payment_reference: 'PAY-20260822-ABCD1234',
      paycloud_merchant_order_no: 'FT17872970116626363',
      customer_email: 'someone@example.com',
    },
  ] as Row[],
  count: 1,
}))

jest.mock('@/lib/guest-orders/queries', () => ({
  fetchGuestActiveTableOrders: (...a: unknown[]) =>
    (fetchGuestActiveTableOrders as unknown as (...x: unknown[]) => unknown)(...a),
}))

async function get(qs: string) {
  const { GET } = await import('@/app/api/guest/orders/active-table/route')
  const res = await GET(new NextRequest(`http://localhost/api/guest/orders/active-table?${qs}`))
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeEach(() => fetchGuestActiveTableOrders.mockClear())

describe('a caller with only the public identifiers', () => {
  const publicOnly = `restaurantId=${RESTAURANT}&table_number=1`

  it('is refused', async () => {
    const res = await get(publicOnly)
    expect(res.status).toBe(403)
    expect(res.body?.code).toBe('SESSION_REQUIRED')
  })

  it('countOnly does NOT leak existence', async () => {
    // The whole finding. A count is not "no data".
    const res = await get(`${publicOnly}&countOnly=1`)
    expect(res.status).toBe(403)
    expect(res.body?.count).toBeUndefined()
  })

  it('no query is run at all, so nothing can leak by timing or error either', async () => {
    await get(publicOnly)
    await get(`${publicOnly}&countOnly=1`)
    expect(fetchGuestActiveTableOrders).not.toHaveBeenCalled()
  })

  it('a blank or whitespace session id does not count as one', async () => {
    expect((await get(`${publicOnly}&session_id=`)).status).toBe(403)
    expect((await get(`${publicOnly}&session_id=%20%20`)).status).toBe(403)
    expect(fetchGuestActiveTableOrders).not.toHaveBeenCalled()
  })
})

describe('a caller WITH a session — unchanged behaviour', () => {
  const withSession = `restaurantId=${RESTAURANT}&table_number=1&session_id=${SESSION}`

  it('still gets their orders', async () => {
    const res = await get(withSession)
    expect(res.status).toBe(200)
    expect(res.body?.orders).toHaveLength(1)
    expect(res.body?.orders?.[0]?.id).toBe('order-1')
  })

  it('still gets a count when it asks for one', async () => {
    const res = await get(`${withSession}&countOnly=1`)
    expect(res.status).toBe(200)
    expect(res.body?.count).toBe(1)
  })

  it('keeps the fields the landing actually renders', async () => {
    // Too-closed is a real failure mode: without these the resume-payment prompt cannot be drawn.
    const o = (await get(withSession)).body.orders[0]
    for (const f of ['id', 'placed_at', 'payment_status', 'payment_channel', 'status', 'total']) {
      expect(o[f]).toBeDefined()
    }
  })
})

describe('the redaction is an allowlist, not select(*) minus one field', () => {
  const withSession = `restaurantId=${RESTAURANT}&table_number=1&session_id=${SESSION}`

  it('never returns a session id — that is a capability, not a detail (#282)', async () => {
    const o = (await get(withSession)).body.orders[0]
    expect(o.session_id).toBeUndefined()
    expect(o.member_session_id).toBeUndefined()
    expect(JSON.stringify(o)).not.toContain(SESSION)
  })

  it('never returns a customer name or what they ordered', async () => {
    const o = (await get(withSession)).body.orders[0]
    expect(o.customer_name).toBeUndefined()
    expect(o.items).toBeUndefined()
  })

  it('never returns identifiers that address the order on other routes', async () => {
    const o = (await get(withSession)).body.orders[0]
    expect(o.payment_reference).toBeUndefined()
    expect(o.paycloud_merchant_order_no).toBeUndefined()
    expect(o.customer_email).toBeUndefined()
  })

  it('a column nobody considered is private by default', async () => {
    // The point of an allowlist. A future migration must not widen this response silently.
    const projected = projectTablemateOrder({ id: 'x', some_new_column_added_later: 'secret' })
    expect(projected).not.toHaveProperty('some_new_column_added_later')
    expect(Object.keys(projected).every((k) => TABLEMATE_ALLOWLIST.includes(k))).toBe(true)
  })
})

describe('the server answers ownership, so the banner never needs the session id', () => {
  const withSession = `restaurantId=${RESTAURANT}&table_number=1&session_id=${SESSION}`

  it('marks the caller\u2019s own rows isMine', async () => {
    // The regression this replaces: the banner compared order.session_id to its own, so redacting
    // that field made EVERY row fail the check and the banner rendered nothing for anybody.
    const o = (await get(withSession)).body.orders[0]
    expect(o.isMine).toBe(true)
  })

  it('derives it rather than reading it off the row', () => {
    // A row that never carried the flag still comes back true, because the caller only receives
    // rows that matched their own session ids. The truth is the query scope, not a column.
    expect(projectTablemateOrder({ id: 'x' }).isMine).toBe(true)
    expect(projectTablemateOrder({ id: 'x', isMine: false }).isMine).toBe(true)
  })

  it('and STILL never returns a session id', () => {
    // #279's guarantee is not traded away to fix the banner.
    const p = projectTablemateOrder({ id: 'x', session_id: SESSION, member_session_id: 'm' })
    expect(p.session_id).toBeUndefined()
    expect(p.member_session_id).toBeUndefined()
    expect(JSON.stringify(p)).not.toContain(SESSION)
  })

  it('isMine is inside the allowlist, so it is not an accidental leak of a new field', () => {
    expect(TABLEMATE_ALLOWLIST).toContain('isMine')
    const p = projectTablemateOrder({ id: 'x', some_future_column: 'secret' })
    expect(Object.keys(p).every((k) => TABLEMATE_ALLOWLIST.includes(k))).toBe(true)
  })
})
