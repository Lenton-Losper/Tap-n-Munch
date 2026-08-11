/**
 * `?ref=` must never be able to widen the query — unauthenticated cross-tenant order disclosure.
 *
 * `paymentRefOrFilter` interpolated the caller's string straight into a PostgREST `.or()` filter.
 * The comma is PostgREST's term separator, so `?ref=zzz,total.gte.0` appended a term matching
 * every row. `/api/guest/orders/by-payment-ref` has no authentication of its own, and when the
 * incident was found the restaurant scope was optional too, so that URL returned up to 15 full
 * order rows across ALL restaurants with no credential and no knowledge of any reference.
 *
 * Reproduced read-only against staging on 2026-08-08: benign unguessable ref -> 0 rows; the
 * injected ref -> 15 rows, that restaurant's entire order table.
 *
 * #254 — THIS BRANCH. The fix landed on `main` only; `cloudflare-staging` kept the injectable
 * form, so the environment everything is reproduced against ran the vulnerable code. Re-measured
 * read-only on staging 2026-08-11 through this branch's own function: benign
 * `NONEXISTENT-REF-ZZZZZZ` -> 0 rows, and `NONEXISTENT-REF-ZZZZZZ,id.not.is.null` -> 213 rows
 * across 2 restaurants with the validation reverted, 0 rows with it in place.
 *
 * Doors 2 and 3 (restaurant scope, per-row `guestCanAccessOrder`) were ALREADY on this branch
 * from wave-2's #122 — so the widening here is bounded by them. That is not a reason to leave
 * door 1 open: the filter can still be widened within a tenant, and a paid/closed row passes
 * door 3 on restaurant scope alone.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. The suite that shipped alongside the original #122 fix could
 * not have caught this: its Supabase stub THREW on any operator other than `.eq` inside `.or()`,
 * hard-coding the exact assumption that turned out to be false, so it went green while the hole
 * was open. The stub below therefore RECORDS what it is given and asserts on it, and never
 * rejects input for being unexpected. A stub that refuses to represent the dangerous case cannot
 * test for it.
 */

/** #122: restaurantId is required now; these cases are about the FILTER, not the scope. */
const RESTAURANT_A = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
// Importing the queries module transitively reaches `lib/supabase/client`, whose
// createBrowserClient throws at import time without these. Absent them the suite dies before any
// assertion runs -- a BROKEN SUITE, which is not the same as a failing test and is not evidence
// of anything. Placeholders only; every query in this file is against a recording stub and no
// request leaves the process.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-key'

import { paymentRefOrFilter, isWellFormedPaymentRef } from '../lib/guest-orders/validation'

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

    const rows = await fetchGuestOrdersByPaymentRef({
      paymentRef: 'zzz,total.gte.0',
      restaurantId: RESTAURANT_A,
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
      restaurantId: RESTAURANT_A,
    })

    expect(calls.or).toHaveLength(1)
    expect(calls.or[0]).toBe(
      'paycloud_merchant_order_no.eq.PAY-20260808-K7M2QRTZ,payment_reference.eq.PAY-20260808-K7M2QRTZ'
    )
  })
})
