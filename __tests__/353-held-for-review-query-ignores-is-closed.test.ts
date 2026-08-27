/**
 * #353 — the Held for review read MUST NOT filter on `is_closed`, and that absence is asserted.
 *
 * THIS IS THE LOAD-BEARING TEST OF THE WHOLE FEATURE, and it exists because the failure it
 * catches is invisible: adding `.eq('is_closed', false)` here compiles, type-checks, passes every
 * other test in the repo, and renders a permanently empty panel.
 *
 * Measured on production 2026-08-27:
 *
 *     stale pending orders ................................... 20   (N$489, oldest 40.6 days)
 *     of those, carrying is_closed = true .................... 20
 *     orders in the ENTIRE database with is_closed = false ....  1
 *
 * Every other read in lib/supabase/orders.ts carries that filter, so copying the house pattern
 * into this function is the natural thing for the next author to do — and it would restore the
 * exact defect: "money still owed stays RECORDED and becomes INVISIBLE at the same moment", as
 * app/api/tables/[tableNumber]/close/route.ts already says of itself.
 *
 * The RLS side is verified separately, against production's pg_policy: `Staff can read orders for
 * their restaurants` (authenticated, SELECT, restaurant_id IN user_restaurant_ids()) carries no
 * is_closed condition, so a signed-in staff member may read these rows. No migration is required.
 *
 * WHAT THE DOUBLE DOES. It records every builder call as `table.method(args)` and answers
 * `.range()` with fixtures, which is how fetchAllRows drives a query. Asserting on the recorded
 * calls is a structural claim about the query — an absence — not a reimplementation of it.
 */
const calls: Array<{ table: string; method: string; args: unknown[] }> = []
let heldRows: Array<Record<string, unknown>> = []
let strandedRows: Array<Record<string, unknown>> = []

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from(table: string) {
      const state = { paymentStatusEq: null as string | null, usedIn: false }
      const chain: Record<string, unknown> = {}
      const record = (method: string, ...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      }
      chain.select = (...a: unknown[]) => record('select', ...a)
      chain.order = (...a: unknown[]) => record('order', ...a)
      chain.lt = (...a: unknown[]) => record('lt', ...a)
      chain.eq = (col: string, val: unknown) => {
        if (col === 'payment_status') state.paymentStatusEq = String(val)
        return record('eq', col, val)
      }
      chain.in = (col: string, val: unknown) => {
        if (col === 'payment_status') state.usedIn = true
        return record('in', col, val)
      }
      chain.range = (from: number) => {
        if (from !== 0) return Promise.resolve({ data: [], error: null })
        // The held leg is the one that used `.in('payment_status', ...)`.
        return Promise.resolve({ data: state.usedIn ? heldRows : strandedRows, error: null })
      }
      return chain
    },
  },
}))

import { getHeldForReviewOrders } from '@/lib/supabase/orders'
import { STRANDED_PENDING_THRESHOLD_MS } from '@/lib/orders/held-for-review'
import { HELD_FOR_REVIEW_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'

const SCOPE = { restaurantId: 'rest-uuid-1' } as never

beforeEach(() => {
  calls.length = 0
  heldRows = []
  strandedRows = []
})

describe('#353 the held-for-review read', () => {
  it('NEVER filters on is_closed', async () => {
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    const isClosedFilters = calls.filter((c) => c.args[0] === 'is_closed')
    expect(isClosedFilters).toEqual([])
  })

  it('scopes to the restaurant', async () => {
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    expect(
      calls.filter((c) => c.method === 'eq' && c.args[0] === 'restaurant_id').length,
    ).toBe(2)
    expect(calls.some((c) => c.args[0] === 'restaurant_id' && c.args[1] === 'rest-uuid-1')).toBe(
      true,
    )
  })

  it('asks for whatever the hold array holds, with NO age filter on that leg', async () => {
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    const inCall = calls.find((c) => c.method === 'in' && c.args[0] === 'payment_status')
    expect(inCall).toBeDefined()
    // Consumed, never counted -- one member today, two once #153 merges.
    expect(inCall!.args[1]).toEqual([...HELD_FOR_REVIEW_PAYMENT_STATUSES])
  })

  it('asks for stranded `pending` with a cutoff derived from the measured threshold', async () => {
    const before = Date.now()
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    const after = Date.now()

    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'payment_status' && c.args[1] === 'pending')).toBe(true)
    const ltCall = calls.find((c) => c.method === 'lt' && c.args[0] === 'placed_at')
    expect(ltCall).toBeDefined()
    const cutoff = Date.parse(String(ltCall!.args[1]))
    expect(cutoff).toBeGreaterThanOrEqual(before - STRANDED_PENDING_THRESHOLD_MS - 5000)
    expect(cutoff).toBeLessThanOrEqual(after - STRANDED_PENDING_THRESHOLD_MS + 5000)
  })

  it('uses PARSER-FREE filters — no .or() string is ever built', async () => {
    // by-payment-ref's PostgREST `.or()` injection was fixed by REFORMULATING rather than
    // sanitising. This query is a disjunction, which is what `.or()` is for; it is expressed as
    // two `.eq()`/`.in()` queries so the seam is never opened in the first place.
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    expect(calls.some((c) => c.method === 'or')).toBe(false)
  })

  it('returns both legs, deduped by id', async () => {
    heldRows = [{ id: 'held-1', payment_status: 'amount_mismatch_hold' }]
    strandedRows = [
      { id: 'stranded-1', payment_status: 'pending' },
      { id: 'held-1', payment_status: 'amount_mismatch_hold' },
    ]
    const rows = await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE })
    expect(rows.map((r) => String((r as { id: unknown }).id)).sort()).toEqual([
      'held-1',
      'stranded-1',
    ])
  })

  it('an explicit threshold moves the cutoff', async () => {
    await getHeldForReviewOrders('rest-1', { scopeOverride: SCOPE, thresholdMs: 0 })
    const ltCall = calls.find((c) => c.method === 'lt' && c.args[0] === 'placed_at')
    expect(Date.parse(String(ltCall!.args[1]))).toBeGreaterThan(Date.now() - 5000)
  })
})
