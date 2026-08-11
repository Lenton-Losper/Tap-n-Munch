/**
 * #122 — the two doors of the union, pinned SEPARATELY.
 *
 * `/api/guest/orders/by-payment-ref` has no authentication of its own: middleware guards
 * `/admin/*` only. Everything between an anonymous caller and another restaurant's order data
 * lives in `fetchGuestOrdersByPaymentRef`.
 *
 * Production carried the VALIDATED FILTER and not the scope. Staging carried the SCOPE and not
 * the validation. Each was shipped as "the #122 fix" on its own branch, and neither branch had
 * both — so this suite exists to make sure whichever half is touched next announces itself.
 *
 * This file is the staging half of that union (#254). Door 2 arrived here with #122; door 1 is
 * what this branch adds, and neither suite existed on `cloudflare-staging` at all — so staging
 * was green on both doors by OMISSION, which is why nothing there noticed the hole was open.
 *
 *   TEST 1  a filter-injecting ref must not widen the query
 *   TEST 2  a VALID, KNOWN reference must not read across tenants
 *
 * Deliberately two tests. They fail for different reasons and neither implies the other:
 * validation stops a caller who knows NO reference from reading everything; the scope stops a
 * caller who knows ONE reference from reading another restaurant's copy of it. A single
 * combined assertion would let either half regress while staying green, which is exactly how
 * two branches each ended up with one of them.
 *
 * Hermetic: the Supabase client is a recording fake. No live rows.
 */

const RESTAURANT_A = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const RESTAURANT_B = 'b161c758-582d-4dfa-839a-9fa35c492a49'

/** A real-shaped reference. Nothing about it is secret — it is printed on a receipt. */
const KNOWN_REF = 'PAY-20260808-K7M2QRTZ'

/** The reproduction from the incident: the comma is PostgREST's term separator. */
const INJECTED_REF = 'zzz,total.gte.0'

type Recorded = { or: string[]; eq: Array<[string, unknown]> }

/**
 * A fake PostgREST builder that records the filters it was asked for and returns `rows`
 * REGARDLESS of them — deliberately. A fake that honoured `.eq()` would prove only that
 * PostgREST filters work; what is under test is whether the code SENDS the constraint and
 * whether it re-checks the rows it gets back. The fake returning an out-of-tenant row is
 * standing in for any way that could happen.
 */
function recordingClient(rows: Array<Record<string, unknown>>) {
  const calls: Recorded = { or: [], eq: [] }
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    select: () => builder,
    or: (s: string) => {
      calls.or.push(s)
      return builder
    },
    limit: () => builder,
    eq: (col: string, val: unknown) => {
      calls.eq.push([col, val])
      return builder
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  })
  return { calls, client: { from: () => builder } }
}

async function load(rows: Array<Record<string, unknown>>) {
  const { calls, client } = recordingClient(rows)
  jest.resetModules()
  jest.doMock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => client }))
  jest.doMock('@/lib/supabase/restaurants', () => ({
    resolveRestaurantUuid: async (x: string) => x,
  }))
  const { fetchGuestOrdersByPaymentRef } = await import('../lib/guest-orders/queries')
  return { calls, fetchGuestOrdersByPaymentRef }
}

describe('#122 — by-payment-ref cross-tenant disclosure', () => {
  it('DOOR 1: an injected reference does not widen the query — no filter is sent at all', async () => {
    // The row set is what the injection returned in the incident: someone else's order. If the
    // filter were sent, the fake would hand it back and it would be disclosed.
    const { calls, fetchGuestOrdersByPaymentRef } = await load([
      { id: 'leaked-1', restaurant_id: RESTAURANT_B, payment_status: 'paid', is_closed: true },
    ])

    const rows = await fetchGuestOrdersByPaymentRef({
      paymentRef: INJECTED_REF,
      restaurantId: RESTAURANT_A,
    })

    expect(rows).toEqual([])
    // The strong form: not "the filter was escaped safely" but "no query was issued".
    expect(calls.or).toHaveLength(0)
  })

  it('DOOR 2: a VALID reference cannot read another restaurant\'s order', async () => {
    // Nothing is malformed here. The caller knows a real reference — off a receipt, or off a
    // gateway return URL — and asks restaurant A for it. The row belongs to restaurant B.
    const { calls, fetchGuestOrdersByPaymentRef } = await load([
      { id: 'other-tenant', restaurant_id: RESTAURANT_B, payment_status: 'paid', is_closed: true },
    ])

    const rows = await fetchGuestOrdersByPaymentRef({
      paymentRef: KNOWN_REF,
      restaurantId: RESTAURANT_A,
    })

    // The query IS issued — this reference is legitimate, so door 1 is not what stops it.
    expect(calls.or).toHaveLength(1)
    // The scope was asked for...
    expect(calls.eq).toContainEqual(['restaurant_id', RESTAURANT_A])
    // ...AND the row is re-checked after it comes back, so a row from another tenant does not
    // survive even when the query returns one.
    expect(rows).toEqual([])
  })

  it('CONTROL: the caller\'s OWN paid order is still returned', async () => {
    // Without this, both tests above would pass if the function simply returned [] always.
    const { fetchGuestOrdersByPaymentRef } = await load([
      { id: 'mine', restaurant_id: RESTAURANT_A, payment_status: 'paid', is_closed: false },
    ])

    const rows = await fetchGuestOrdersByPaymentRef({
      paymentRef: KNOWN_REF,
      restaurantId: RESTAURANT_A,
    })

    expect(rows.map((r) => r.id)).toEqual(['mine'])
  })

  it('CONTROL: an OPEN order needs the table or session, and is returned when given', async () => {
    // The per-row gate is not "same restaurant". An unpaid, open order additionally needs the
    // table or session that placed it — which is why the confirmation screen's poll passes both.
    const open = { id: 'open-1', restaurant_id: RESTAURANT_A, payment_status: 'pending', status: 'preparing', is_closed: false, table_number: 12, session_id: 'sess-abc' }

    const a = await load([open])
    expect(
      await a.fetchGuestOrdersByPaymentRef({ paymentRef: KNOWN_REF, restaurantId: RESTAURANT_A }),
    ).toEqual([])

    const b = await load([open])
    expect(
      (
        await b.fetchGuestOrdersByPaymentRef({
          paymentRef: KNOWN_REF,
          restaurantId: RESTAURANT_A,
          tableNumber: 12,
        })
      ).map((r) => r.id),
    ).toEqual(['open-1'])
  })

  it('an absent restaurantId returns nothing rather than every tenant', async () => {
    const { calls, fetchGuestOrdersByPaymentRef } = await load([
      { id: 'leaked-2', restaurant_id: RESTAURANT_B, payment_status: 'paid', is_closed: true },
    ])

    const rows = await fetchGuestOrdersByPaymentRef({ paymentRef: KNOWN_REF, restaurantId: '  ' })

    expect(rows).toEqual([])
    expect(calls.or).toHaveLength(0)
  })
})
