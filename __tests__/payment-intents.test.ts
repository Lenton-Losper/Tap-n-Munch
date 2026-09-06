/**
 * ONE REFERENCE PER CARD CHARGE — the intent, and the resolver leg that finds it.
 *
 * ================================================================================================
 * THE PROPERTY THAT MATTERS MOST HERE IS A NEGATIVE ONE
 * ================================================================================================
 *
 * The whole-order card path must run the same code tomorrow as today. Owner's ruling, 2026-09-06,
 * and it is held harder than the feature: every venue's ordinary card payment goes through
 * `orders.paycloud_merchant_order_no`, and a defect in the split path must not be able to reach it.
 *
 * So the first thing asserted is that a reference which resolves today resolves identically with
 * the intent leg in place — same orders, same source, and the intent leg not merely bypassed but
 * measurably not consulted for it.
 *
 * ================================================================================================
 * FAKE SUPABASE, NOT A MOCK OF THE MODULE UNDER TEST
 * ================================================================================================
 *
 * The queries are the thing being tested — which table, which filter, which order the legs run in.
 * Mocking `findIntentByMerchantOrderNo` would assert that a stub was called. This fakes the client
 * instead, so the assertions are about the reads that actually happen.
 */
import {
  createPaymentIntent,
  findIntentByMerchantOrderNo,
  allocationIdsHeldByLiveCard,
  markIntentConfirmed,
  markIntentUncertain,
} from '@/lib/payments/payment-intents'
import { resolveOrderIdsByMerchantOrderNo } from '@/lib/payments/resolve-order-by-merchant-order'

type Row = Record<string, unknown>

/** Records every table touched, so "was this leg consulted at all" is answerable. */
function fakeSupabase(
  tables: Record<string, Row[]>,
  touched: string[] = [],
  /** Tables whose reads fail, so fail-closed behaviour can be measured rather than assumed. */
  failReadsOn: string[] = [],
) {
  const client = {
    touched,
    from(table: string) {
      touched.push(table)
      const readFails = failReadsOn.includes(table)
      const state: { rows: Row[]; inserted?: Row; updates?: Row } = {
        rows: [...(tables[table] ?? [])],
      }
      const builder: Record<string, unknown> = {
        select() {
          return builder
        },
        insert(row: Row) {
          state.inserted = row
          const existing = tables[table] ?? []
          const clash = existing.some(
            (r) => r.merchant_order_no && r.merchant_order_no === row.merchant_order_no,
          )
          if (clash) {
            state.rows = []
            ;(builder as { __error?: unknown }).__error = { code: '23505', message: 'duplicate key' }
          } else {
            const created = { id: `intent_${existing.length + 1}`, ...row }
            existing.push(created)
            tables[table] = existing
            state.rows = [created]
          }
          return builder
        },
        update(patch: Row) {
          state.updates = patch
          return builder
        },
        eq(column: string, value: unknown) {
          state.rows = state.rows.filter((r) => r[column] === value)
          return builder
        },
        neq(column: string, value: unknown) {
          state.rows = state.rows.filter((r) => r[column] !== value)
          return builder
        },
        in(column: string, values: unknown[]) {
          state.rows = state.rows.filter((r) => values.includes(r[column]))
          return builder
        },
        overlaps(column: string, values: string[]) {
          state.rows = state.rows.filter((r) => {
            const arr = (r[column] as string[] | null) ?? []
            return arr.some((v) => values.includes(v))
          })
          return builder
        },
        limit() {
          return builder
        },
        range() {
          return Promise.resolve({ data: state.rows, error: null })
        },
        maybeSingle() {
          const error = (builder as { __error?: unknown }).__error
          return Promise.resolve({ data: state.rows[0] ?? null, error: error ?? null })
        },
        single() {
          const error = (builder as { __error?: unknown }).__error
          return Promise.resolve({ data: state.rows[0] ?? null, error: error ?? null })
        },
        /**
         * A PENDING UPDATE IS APPLIED HERE, AFTER EVERY FILTER — not as each filter runs.
         *
         * The first version of this fake assigned the patch inside `eq()`, so `.eq(id).neq(status,
         * 'confirmed')` had already written by the time `neq` narrowed. It reported a real guard as
         * broken. Postgres evaluates the whole WHERE and then writes; so does this now.
         */
        then(resolve: (v: { data: Row[] | null; error: unknown }) => unknown) {
          if (readFails) {
            return Promise.resolve({ data: null, error: { message: 'read failed' } }).then(resolve)
          }
          if (state.updates) {
            for (const r of state.rows) Object.assign(r, state.updates)
          }
          return Promise.resolve({ data: state.rows, error: null }).then(resolve)
        },
      }
      return builder
    },
  }
  return client as unknown as Parameters<typeof findIntentByMerchantOrderNo>[0]
}

describe('the whole-order path is untouched', () => {
  it('an order reference resolves to the same orders, through `orders`, exactly as before', async () => {
    const touched: string[] = []
    const db = fakeSupabase(
      {
        terminal_payment_intents: [],
        orders: [{ id: 'order-1', paycloud_merchant_order_no: 'FT1785150026491', payment_reference: null }],
      },
      touched,
    )

    const resolved = await resolveOrderIdsByMerchantOrderNo(db, 'FT1785150026491')

    expect(resolved.orderIds).toEqual(['order-1'])
    expect(resolved.source).toBe('orders')
    // The new field is absent for an old reference, so a caller reading only orderIds/source is
    // looking at exactly what it looked at before.
    expect(resolved.intent ?? null).toBeNull()
  })

  it('a reference that is not an intent falls through, rather than being answered by the new leg', async () => {
    const touched: string[] = []
    const db = fakeSupabase(
      { terminal_payment_intents: [], orders: [{ id: 'order-9', paycloud_merchant_order_no: 'FT-OLD', payment_reference: null }] },
      touched,
    )

    await resolveOrderIdsByMerchantOrderNo(db, 'FT-OLD')

    // The intent leg IS consulted (it must be, to know), and then the orders leg answers.
    expect(touched).toContain('terminal_payment_intents')
    expect(touched).toContain('orders')
    expect(touched.indexOf('terminal_payment_intents')).toBeLessThan(touched.indexOf('orders'))
  })

  it('an unknown reference still resolves to nothing', async () => {
    const db = fakeSupabase({ terminal_payment_intents: [], orders: [], payment_events: [] })
    const resolved = await resolveOrderIdsByMerchantOrderNo(db, 'FT-NOBODY')
    expect(resolved.orderIds).toEqual([])
    expect(resolved.source).toBeNull()
  })
})

describe('an allocations intent resolves as allocations, never as orders', () => {
  /**
   * THE DANGEROUS CONFUSION. A caller that reads `orderIds` and marks those orders paid would close
   * an order three quarters of which nobody has paid for — which is exactly what the webhook does
   * today for every reference it resolves. The scope is what stops it, so the scope is asserted.
   *
   * Mutation-verified: reporting an allocations intent as scope 'orders' left every other test in
   * this file green.
   */
  const db = () =>
    fakeSupabase({
      terminal_payment_intents: [
        {
          id: 'i1',
          merchant_order_no: 'FT-SPLIT-1',
          amount_cents: 4750,
          scope: 'allocations',
          order_ids: null,
          allocation_ids: ['a1', 'a2'],
          status: 'launched',
          restaurant_id: 'r1',
          tab_id: 'tab1',
        },
      ],
      order_line_allocations: [
        { id: 'a1', order_line_id: 'l1', order_lines: {order_id: 'order-7'} },
        { id: 'a2', order_line_id: 'l2', order_lines: {order_id: 'order-7'} },
      ],
    })

  it('reports scope allocations and carries the allocation ids', async () => {
    const resolved = await resolveOrderIdsByMerchantOrderNo(db(), 'FT-SPLIT-1')
    expect(resolved.source).toBe('intent')
    expect(resolved.intent?.scope).toBe('allocations')
    expect(resolved.intent?.allocationIds.sort()).toEqual(['a1', 'a2'])
  })

  it('still names the orders those allocations sit on, without claiming they are paid', async () => {
    // Somewhere to look, not something to close. Deduplicated: two allocations on one order.
    const resolved = await resolveOrderIdsByMerchantOrderNo(db(), 'FT-SPLIT-1')
    expect(resolved.orderIds).toEqual(['order-7'])
  })

  it('carries the amount the reader was asked for, for the sale reconciliation', async () => {
    const resolved = await resolveOrderIdsByMerchantOrderNo(db(), 'FT-SPLIT-1')
    expect(resolved.intent?.amountCents).toBe(4750)
  })
})

describe('minting', () => {
  it('gives every charge its own reference', async () => {
    /**
     * THE ENTIRE POINT. `orders.paycloud_merchant_order_no` reuses by design — its no-rotation rule
     * exists to stop orphaned webhooks — and that reuse is what made a second card charge on one
     * order indistinguishable from the first.
     */
    const db = fakeSupabase({ terminal_payment_intents: [] })
    const first = await createPaymentIntent(db, {
      restaurantId: 'r1', terminalId: 't1', tabId: 'tab1',
      amountCents: 4750, scope: 'allocations', allocationIds: ['a1'],
    })
    const second = await createPaymentIntent(db, {
      restaurantId: 'r1', terminalId: 't1', tabId: 'tab1',
      amountCents: 3200, scope: 'allocations', allocationIds: ['a2'],
    })

    expect(first.merchantOrderNo).not.toBe(second.merchantOrderNo)
    expect(first.amountCents).toBe(4750)
    expect(second.amountCents).toBe(3200)
  })

  it('records what the reader was asked for, not what an order totals', async () => {
    // The figure that makes the sale route's reconciliation possible at all.
    const db = fakeSupabase({ terminal_payment_intents: [] })
    const intent = await createPaymentIntent(db, {
      restaurantId: 'r1', terminalId: null, tabId: null,
      amountCents: 999, scope: 'allocations', allocationIds: ['a1'],
    })
    expect(intent.amountCents).toBe(999)
    expect(intent.status).toBe('launched')
  })

  it('refuses an intent that names nothing', async () => {
    // A row with no target leaves the webhook guessing what to settle.
    const db = fakeSupabase({ terminal_payment_intents: [] })
    await expect(
      createPaymentIntent(db, {
        restaurantId: 'r1', terminalId: null, tabId: null,
        amountCents: 100, scope: 'allocations', allocationIds: [],
      }),
    ).rejects.toThrow(/at least one allocation/)
    await expect(
      createPaymentIntent(db, {
        restaurantId: 'r1', terminalId: null, tabId: null,
        amountCents: 100, scope: 'orders', orderIds: [],
      }),
    ).rejects.toThrow(/at least one order/)
  })

  it('refuses a non-positive amount rather than asking a reader for it', async () => {
    const db = fakeSupabase({ terminal_payment_intents: [] })
    for (const amountCents of [0, -1, Number.NaN]) {
      await expect(
        createPaymentIntent(db, {
          restaurantId: 'r1', terminalId: null, tabId: null,
          amountCents, scope: 'allocations', allocationIds: ['a1'],
        }),
      ).rejects.toThrow(/positive integer/)
    }
  })
})

describe('the hold', () => {
  const heldDb = () =>
    fakeSupabase({
      terminal_payment_intents: [
        { id: 'i1', restaurant_id: 'r1', scope: 'allocations', status: 'launched', allocation_ids: ['a1', 'a2'] },
        { id: 'i2', restaurant_id: 'r1', scope: 'allocations', status: 'uncertain', allocation_ids: ['a3'] },
        { id: 'i3', restaurant_id: 'r1', scope: 'allocations', status: 'confirmed', allocation_ids: ['a4'] },
        { id: 'i4', restaurant_id: 'r1', scope: 'allocations', status: 'failed', allocation_ids: ['a5'] },
      ],
    })

  it('a launched card holds its allocations', async () => {
    const held = await allocationIdsHeldByLiveCard(heldDb(), {
      restaurantId: 'r1',
      allocationIds: ['a1', 'a2'],
    })
    expect(held.sort()).toEqual(['a1', 'a2'])
  })

  it('an UNCERTAIN card holds hardest of all', async () => {
    /**
     * E04111 means no record, never not-paid. Releasing these would let a second customer pay for
     * the first customer's food while the first customer's card was still settling — and the tab
     * stays open for exactly that long.
     */
    const held = await allocationIdsHeldByLiveCard(heldDb(), { restaurantId: 'r1', allocationIds: ['a3'] })
    expect(held).toEqual(['a3'])
  })

  it('a confirmed or failed card holds nothing', async () => {
    // Confirmed is settled; failed released. Neither blocks anyone.
    const held = await allocationIdsHeldByLiveCard(heldDb(), {
      restaurantId: 'r1',
      allocationIds: ['a4', 'a5'],
    })
    expect(held).toEqual([])
  })

  it('returns only the allocations that were ASKED about', async () => {
    // i1 holds a1 and a2; a question about a1 alone must not report a2 as blocked.
    const held = await allocationIdsHeldByLiveCard(heldDb(), { restaurantId: 'r1', allocationIds: ['a1'] })
    expect(held).toEqual(['a1'])
  })

  it('asking about nothing reads nothing', async () => {
    const touched: string[] = []
    const db = fakeSupabase({ terminal_payment_intents: [] }, touched)
    expect(await allocationIdsHeldByLiveCard(db, { restaurantId: 'r1', allocationIds: [] })).toEqual([])
    expect(touched).toEqual([])
  })
})

describe('resolution is one-way', () => {
  it('a confirmed intent can never be walked back to uncertain', async () => {
    /**
     * A late ambiguous device outcome arriving after a webhook already settled would otherwise
     * hold items that are paid for, and show a waiter "card pending" on food nobody owes for.
     */
    const rows = [{ id: 'i1', status: 'confirmed', resolved_at: null }]
    const db = fakeSupabase({ terminal_payment_intents: rows })
    await markIntentUncertain(db, 'i1')
    expect(rows[0].status).toBe('confirmed')
  })

  it('a launched intent moves, and stamps when', async () => {
    const rows = [{ id: 'i1', status: 'launched', resolved_at: null }]
    const db = fakeSupabase({ terminal_payment_intents: rows })
    await markIntentConfirmed(db, 'i1')
    expect(rows[0].status).toBe('confirmed')
    expect(rows[0].resolved_at).not.toBeNull()
  })
})

describe('nothing auto-resolves an uncertain intent', () => {
  it('the module exports no timeout, sweep, or expiry', async () => {
    /**
     * Owner's ruling, 2026-09-06: a webhook or a human, and nothing else. Asserted over the module's
     * own surface, because the tempting thing to add later is a cron that "tidies up" old intents —
     * and that cron would either take a real charge twice or give away a meal.
     */
    const mod = await import('@/lib/payments/payment-intents')
    const names = Object.keys(mod)
    for (const forbidden of ['expire', 'sweep', 'reap', 'timeout', 'autoResolve', 'cancelStale']) {
      expect({ forbidden, present: names.some((n) => n.toLowerCase().includes(forbidden.toLowerCase())) })
        .toEqual({ forbidden, present: false })
    }
  })
})

describe('the hold FAILS CLOSED', () => {
  it('a failed read is not permission to take the money again', async () => {
    /**
     * If this returned [] on an error, cash would be takeable for items a card is still settling —
     * the exact double-charge the hold exists to prevent, reached by a transient database blip
     * rather than by any decision. Not being able to READ the hold is not the same as there not
     * being one.
     *
     * Mutation-verified: turning the throw into `return []` left every other test in this file
     * green, which is why this one exists.
     */
    const db = fakeSupabase(
      { terminal_payment_intents: [{ id: 'i1', restaurant_id: 'r1', scope: 'allocations', status: 'launched', allocation_ids: ['a1'] }] },
      [],
      ['terminal_payment_intents'],
    )
    await expect(
      allocationIdsHeldByLiveCard(db, { restaurantId: 'r1', allocationIds: ['a1'] }),
    ).rejects.toThrow(/allocationIdsHeldByLiveCard/)
  })
})
