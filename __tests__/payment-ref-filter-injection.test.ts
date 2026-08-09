/**
 * `?ref=` must never be able to widen the query — unauthenticated cross-tenant order disclosure.
 *
 * `paymentRefOrFilter` interpolated the caller's string straight into a PostgREST `.or()` filter.
 * The comma is PostgREST's term separator, so `?ref=zzz,total.gte.0` appended a term matching
 * every row. `/api/guest/orders/by-payment-ref` has no authentication, and on `main`
 * `restaurantId` is optional, so that URL returned up to 15 full order rows across ALL
 * restaurants with no credential and no knowledge of any reference.
 *
 * Reproduced read-only against staging on 2026-08-08: benign unguessable ref -> 0 rows; the
 * injected ref -> 15 rows, that restaurant's entire order table.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. The suite that shipped alongside the original #122 fix could
 * not have caught this: its Supabase stub THREW on any operator other than `.eq` inside `.or()`,
 * hard-coding the exact assumption that turned out to be false, so it went green while the hole
 * was open. The stub below therefore RECORDS what it is given and asserts on it, and never
 * rejects input for being unexpected. A stub that refuses to represent the dangerous case cannot
 * test for it.
 */
// Importing the queries module transitively reaches `lib/supabase/client`, whose
// createBrowserClient throws at import time without these. Absent them the suite dies before any
// assertion runs -- a BROKEN SUITE, which is not the same as a failing test and is not evidence
// of anything. Placeholders only; every query in this file is against a recording stub and no
// request leaves the process.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-key'

import { paymentRefOrFilter, isWellFormedPaymentRef } from '../lib/guest-orders/validation'

/**
 * A real-shaped UUID. `resolveRestaurantUuid` returns a UUID unchanged without querying
 * (`lib/supabase/restaurants.ts` — `if (isUuid(id)) return id`), so this keeps the suite
 * hermetic even though the scoping half of #122 now runs before the query.
 */
const RESTAURANT_ID = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'

/** Payloads that must never reach PostgREST. The first is the one proven live on staging. */
const INJECTIONS = [
  'zzz,total.gte.0',
  'zzz,payment_status.eq.paid',
  'zzz,id.not.is.null',
  'zzz,status.eq.pending',
  'zzz),(total.gte.0',
  'zzz,or(total.gte.0)',
  '*',
  'PAY-20260808-AAAAAAAA,total.gte.0',
]

/** Real shapes this system issues. These must keep working — the fix is worthless if it breaks lookup. */
const LEGITIMATE = [
  'PAY-20260808-K7M2QRTZ',
  'FT17851579657531677',
  'PAY-20260101-ABCDEFGH',
  'abc123',
]

describe('paymentRefOrFilter rejects anything that is not a reference', () => {
  it.each(INJECTIONS)('refuses to build a filter for %p', (payload) => {
    expect(paymentRefOrFilter(payload)).toBeNull()
    expect(isWellFormedPaymentRef(payload)).toBe(false)
  })

  it.each(LEGITIMATE)('still builds a filter for the real reference %p', (ref) => {
    const filter = paymentRefOrFilter(ref)
    expect(filter).not.toBeNull()
    expect(filter).toContain(`payment_reference.eq.${ref}`)
    expect(filter).toContain(`paycloud_merchant_order_no.eq.${ref}`)
  })

  it('never emits more than the two intended OR terms', () => {
    // The structural invariant, independent of any blocklist: exactly one comma separating
    // exactly two `.eq.` terms. If a future edit reintroduces interpolation, this fails even for
    // a payload nobody thought to add to INJECTIONS above.
    for (const ref of LEGITIMATE) {
      const filter = paymentRefOrFilter(ref) as string
      expect(filter.split(',')).toHaveLength(2)
      expect(filter.match(/\.eq\./g)).toHaveLength(2)
      expect(filter).not.toMatch(/\.(gte|lte|gt|lt|neq|like|ilike|in|not|is)\./)
    }
  })

  it('trims, and treats whitespace-only as not a reference', () => {
    expect(paymentRefOrFilter('  PAY-20260808-K7M2QRTZ  ')).toContain('PAY-20260808-K7M2QRTZ')
    expect(paymentRefOrFilter('   ')).toBeNull()
    expect(paymentRefOrFilter('')).toBeNull()
  })

  it('rejects an over-long reference rather than passing it through', () => {
    expect(paymentRefOrFilter('A'.repeat(65))).toBeNull()
    expect(paymentRefOrFilter('A'.repeat(64))).not.toBeNull()
  })
})

describe('the lookup fails CLOSED, and the query is never issued', () => {
  /**
   * Records calls. Deliberately permissive: it accepts any operator string, because the whole
   * point is to observe what WOULD have been sent to PostgREST rather than to decide in advance
   * what is legal.
   */
  function recordingClient() {
    const calls: { or: string[]; limit: number[] } = { or: [], limit: [] }
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      select: () => builder,
      or: (s: string) => {
        calls.or.push(s)
        return builder
      },
      limit: (n: number) => {
        calls.limit.push(n)
        return builder
      },
      eq: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
    })
    return { calls, client: { from: () => builder } }
  }

  it('issues NO query at all for an injected reference', async () => {
    const { calls, client } = recordingClient()
    jest.resetModules()
    jest.doMock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => client }))
    const { fetchGuestOrdersByPaymentRef } = await import('../lib/guest-orders/queries')

    // `restaurantId` became REQUIRED when #122's auth half merged in. That is the other half of
    // the same fix: this guard stops the filter being widened, the scoping stops a valid
    // reference being read cross-tenant. Passing a real id here keeps this test aimed at the
    // injection rather than accidentally passing because the scope check rejected it first.
    const rows = await fetchGuestOrdersByPaymentRef({
      paymentRef: 'zzz,total.gte.0',
      restaurantId: RESTAURANT_ID,
    })

    expect(rows).toEqual([])
    // The strong assertion: not "the filter was safe" but "no filter was sent".
    expect(calls.or).toHaveLength(0)
  })

  it('CONTROL: a legitimate reference still issues exactly one correct filter', async () => {
    // Without this, "issues no query" would also pass if the function were broken outright.
    const { calls, client } = recordingClient()
    jest.resetModules()
    jest.doMock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => client }))
    const { fetchGuestOrdersByPaymentRef } = await import('../lib/guest-orders/queries')

    await fetchGuestOrdersByPaymentRef({
      paymentRef: 'PAY-20260808-K7M2QRTZ',
      restaurantId: RESTAURANT_ID,
    })

    expect(calls.or).toHaveLength(1)
    expect(calls.or[0]).toBe(
      'paycloud_merchant_order_no.eq.PAY-20260808-K7M2QRTZ,payment_reference.eq.PAY-20260808-K7M2QRTZ'
    )
  })
})
