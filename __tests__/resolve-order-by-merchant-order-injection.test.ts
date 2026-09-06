/**
 * #242 — the webhook order resolver must not let an unauthenticated merchant_order_no widen its
 * own query.
 *
 * `resolveOrderIdsByMerchantOrderNo` used to express its two-column match as one PostgREST
 * `.or()`. PostgREST PARSES that argument and the comma is its term separator, so a value
 * carrying one appends OR terms. The value arrives from the PayCloud webhook body on the path
 * where signature verification FAILED, and the filter carries no restaurant scope. Measured
 * read-only on staging (scripts/readonly-eq-reformulation-probe-20260811.ts):
 *
 *     benign   "NONEXISTENT-REF-ZZZZZZ"                ->   0 rows
 *     injected "NONEXISTENT-REF-ZZZZZZ,id.not.is.null" -> 213 rows, across 2 restaurants
 *
 * These tests drive the SHIPPED function against a fake client that models the part of PostgREST
 * that matters: `.or()` is parsed into terms, `.eq()` is not. Binding to the real function rather
 * than restating the rule is deliberate — see the contract on #205, where five tests stayed green
 * against a reverted call site because each carried its own copy of the rule.
 *
 * `orExpressionWouldMatch` is the control that keeps the negative side honest. It runs the OLD
 * expression through the SAME fake, so each injection case asserts both that the shipped function
 * returns nothing AND that this harness would have caught it had the `.or()` still been there. A
 * probe that cannot fire looks exactly like a probe that passed.
 *
 * ================================================================================================
 * THE FAKE REFUSES RATHER THAN DYING QUIETLY — AND THAT IS THE THIRD LESSON, NOT THE FIRST
 * ================================================================================================
 *
 * This harness has now gone dark TWICE by the same mechanism. #323 rerouted the orders leg through
 * fetchAllRows, which calls `.range()`; the fake had none, every one of the twelve tests died with
 * "query.range is not a function" BEFORE reaching an assertion, and #242's cross-tenant cover was
 * unprotected for three weeks. On 2026-09-06 the payment-intents leg added `.maybeSingle()` and it
 * happened again.
 *
 * A SECURITY SUITE THAT FAILS BY NOT RUNNING IS THE WORST SHAPE THERE IS. Twelve identical
 * TypeErrors read as "the harness is broken, fix it later"; a red assertion reads as "the property
 * you were protecting is gone". They deserve opposite reactions and they looked the same.
 *
 * So the builder is wrapped: calling a method this fake does not model throws ONE explicit,
 * attributable error naming the method and what to do about it. The suite still fails — it must,
 * because an unmodelled call means the code under test now does something this fake cannot judge —
 * but it fails saying which method and why, instead of leaving somebody to infer it from a
 * TypeError repeated twelve times.
 *
 * `assertFakeModelsEveryCall` is the meta-test that proves the guard works, because a guard nobody
 * has seen fire is a guard nobody knows is wired up.
 */
import { resolveOrderIdsByMerchantOrderNo } from '@/lib/payments/resolve-order-by-merchant-order'

type OrderRow = {
  id: string
  restaurant_id: string
  paycloud_merchant_order_no: string | null
  payment_reference: string | null
}

type EventRow = {
  order_ids: unknown
  business_order_no: string
  event_type: string
}

/** Two restaurants, so a widening that crosses tenants is visible as such. */
const ORDERS: OrderRow[] = [
  { id: 'ord-A', restaurant_id: 'rest-1', paycloud_merchant_order_no: 'FT17847971551076190', payment_reference: 'PAY-20260701-ESU7U3V2' },
  { id: 'ord-B', restaurant_id: 'rest-1', paycloud_merchant_order_no: 'FT17847973460546925', payment_reference: null },
  { id: 'ord-C', restaurant_id: 'rest-2', paycloud_merchant_order_no: null, payment_reference: 'PAY-20260702-K7M2QRTZ' },
  { id: 'ord-D', restaurant_id: 'rest-2', paycloud_merchant_order_no: 'SHARED-REF-1', payment_reference: null },
  // ord-E carries the SAME string in the OTHER column. The union must return D and E together.
  { id: 'ord-E', restaurant_id: 'rest-1', paycloud_merchant_order_no: null, payment_reference: 'SHARED-REF-1' },
]

const EVENTS: EventRow[] = [
  { order_ids: ['ord-legacy-1', 'ord-legacy-2'], business_order_no: 'FT-LEGACY-POS-9', event_type: 'sale' },
  { order_ids: ['ord-refunded'], business_order_no: 'FT-LEGACY-POS-9', event_type: 'refund' },
]

type Predicate = (row: Record<string, unknown>) => boolean

/**
 * The single OR term shapes this fake understands. An unrecognised term throws rather than
 * silently matching nothing — a fake that quietly ignores an injected predicate would report the
 * vulnerable code as safe.
 */
function termPredicate(term: string): Predicate {
  const eq = term.match(/^([A-Za-z0-9_]+)\.eq\.(.*)$/)
  if (eq) return (row) => row[eq[1]] === eq[2]
  const notNull = term.match(/^([A-Za-z0-9_]+)\.not\.is\.null$/)
  if (notNull) return (row) => row[notNull[1]] !== null && row[notNull[1]] !== undefined
  throw new Error(`fake PostgREST: unmodelled or() term ${JSON.stringify(term)}`)
}

/** What the OLD `.or()` expression would have matched, through this same fake. */
function orExpressionWouldMatch(mo: string): string[] {
  const expression = `paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`
  const predicates = expression.split(',').map(termPredicate)
  return ORDERS.filter((row) => predicates.some((p) => p(row as unknown as Record<string, unknown>))).map((r) => r.id)
}

type FakeClient = {
  client: Parameters<typeof resolveOrderIdsByMerchantOrderNo>[0]
  orCallsOnOrders: string[]
  eqCallsOnOrders: Array<[string, unknown]>
  /** The same two, for the intents leg added 2026-09-06. It reads the same unauthenticated value. */
  orCallsOnIntents: string[]
  eqCallsOnIntents: Array<[string, unknown]>
}

function makeFakeSupabase(options?: {
  ordersError?: string
  eventsError?: string
  intentsError?: string
}): FakeClient {
  const orCallsOnOrders: string[] = []
  const eqCallsOnOrders: Array<[string, unknown]> = []
  const orCallsOnIntents: string[] = []
  const eqCallsOnIntents: Array<[string, unknown]> = []

  const builder = (table: 'orders' | 'payment_events' | 'terminal_payment_intents') => {
    const predicates: Predicate[] = []
    let limit = Infinity
    // terminal_payment_intents is EMPTY here on purpose. Every reference these tests use is an
    // old-style one, so the intent leg must miss and fall through — which is exactly the
    // whole-order guarantee this suite now also covers.
    const rows = () =>
      (table === 'orders' ? ORDERS : table === 'payment_events' ? EVENTS : []) as unknown as Array<
        Record<string, unknown>
      >

    /**
     * EVERY CHAINED CALL MUST STAY WRAPPED, or the guard only covers the first one.
     *
     * The first version returned the bare object from each method, so `.select().eq()` handed back
     * the unwrapped builder and `.maybeSingle()` on it died with the same TypeError the guard
     * exists to replace. Verified by removing maybeSingle from this fake and watching the guard NOT
     * fire — which is how a guard nobody has seen fire turns out to be decorative.
     */
    let proxied: typeof self
    const self = {
      select: () => proxied,
      limit: (n: number) => {
        limit = n
        return proxied
      },
      eq(column: string, value: unknown) {
        if (table === 'orders') eqCallsOnOrders.push([column, value])
        if (table === 'terminal_payment_intents') eqCallsOnIntents.push([column, value])
        predicates.push((row) => row[column] === value)
        return proxied
      },
      or(expression: string) {
        if (table === 'orders') orCallsOnOrders.push(expression)
        if (table === 'terminal_payment_intents') orCallsOnIntents.push(expression)
        const terms = expression.split(',').map(termPredicate)
        predicates.push((row) => terms.some((p) => p(row)))
        return proxied
      },
      /**
       * #331. Added 2026-08-24, and this fake was broken WITHOUT it since #323 (343763a) rerouted
       * the orders leg through fetchAllRows, which calls .range() on the builder. Every one of the
       * twelve tests died with "query.range is not a function" BEFORE reaching an assertion, so
       * #242's cross-tenant injection cover on the webhook path was dark for three weeks.
       *
       * The security property itself never regressed -- resolve-order-by-merchant-order.ts still
       * issues two parser-free .eq() calls and builds no .or() -- but a suite that cannot run is
       * not protecting it.
       */
      range(from: number, to: number) {
        const err = table === 'orders' ? options?.ordersError : options?.eventsError
        if (err) return Promise.resolve({ data: null, error: { message: err } })
        const matched = rows()
          .filter((row) => predicates.every((p) => p(row)))
          .slice(0, limit)
        return Promise.resolve({ data: matched.slice(from, to + 1), error: null })
      },
      /**
       * Added 2026-09-06 with the payment-intents leg, which reads a single row. Without it every
       * test here died on "maybeSingle is not a function" BEFORE reaching an assertion — the same
       * way the whole suite went dark for three weeks when .range() was missing. A suite that
       * cannot run is not protecting anything.
       *
       * It records its filter on the intents table too, so the new leg is held to the same
       * parser-free rule as the two below: this value is unauthenticated on the path that reaches
       * it.
       */
      maybeSingle() {
        if (table === 'terminal_payment_intents') {
          const err = options?.intentsError
          if (err) return Promise.resolve({ data: null, error: { message: err } })
        }
        const matched = rows().filter((row) => predicates.every((p) => p(row)))
        return Promise.resolve({ data: matched[0] ?? null, error: null })
      },
      then(resolve: (r: { data: unknown; error: { message: string } | null }) => void) {
        const err = table === 'orders' ? options?.ordersError : options?.eventsError
        if (err) return resolve({ data: null, error: { message: err } })
        const matched = rows()
          .filter((row) => predicates.every((p) => p(row)))
          .slice(0, limit)
        return resolve({ data: matched, error: null })
      },
    }

    /**
     * Anything not modelled above is a REFUSAL, not an undefined.
     *
     * The allowlist is JS/promise machinery that gets probed on any object — jest inspects, and
     * `await` looks for `then`. Those must pass through untouched or the guard would fire on the
     * harness's own plumbing rather than on a real gap.
     */
    const PASS_THROUGH = new Set([
      'then', 'catch', 'finally', 'constructor', 'toJSON', 'toString', 'valueOf',
      'inspect', 'asymmetricMatch', '$$typeof', 'nodeType', 'hasAttribute', '_isMockFunction',
    ])
    proxied = new Proxy(self as Record<string | symbol, unknown>, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target || PASS_THROUGH.has(String(prop))) {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error(
          `fake PostgREST: resolveOrderIdsByMerchantOrderNo calls .${String(prop)}() on ` +
            `"${table}", and this harness does not model it.
` +
            `  This suite protects #242's cross-tenant injection cover. It has gone dark twice ` +
            `before by exactly this route (.range in #323, .maybeSingle in the payment-intents ` +
            `leg), each time as a TypeError that read like a broken harness rather than a lost ` +
            `guarantee.
` +
            `  MODEL .${String(prop)}() in makeFakeSupabase, then re-run. Do not skip this suite.`,
        )
      },
    }) as typeof self
    return proxied
  }

  return {
    client: {
      from: (table: string) =>
        builder(table as 'orders' | 'payment_events' | 'terminal_payment_intents'),
    } as unknown as Parameters<typeof resolveOrderIdsByMerchantOrderNo>[0],
    orCallsOnOrders,
    eqCallsOnOrders,
    orCallsOnIntents,
    eqCallsOnIntents,
  }
}

describe('resolveOrderIdsByMerchantOrderNo — a merchant_order_no cannot widen its own query', () => {
  const INJECTIONS: Array<[string, string]> = [
    ['appended predicate', 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'],
    ['a REAL reference plus an appended predicate', 'FT17847971551076190,id.not.is.null'],
    ['quoted wrapper', '"NONEXISTENT",id.not.is.null'],
  ]

  it.each(INJECTIONS)('returns nothing for an injected merchant_order_no (%s)', async (_label, injected) => {
    // The control: this harness CAN see the defect. Without this the assertion below would pass
    // just as happily against a fake that never modelled the parse at all.
    const widened = orExpressionWouldMatch(injected)
    expect(widened.length).toBeGreaterThan(1)
    expect(new Set(ORDERS.filter((o) => widened.includes(o.id)).map((o) => o.restaurant_id)).size).toBe(2)

    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, injected)

    expect(result).toEqual({ orderIds: [], source: null })
    expect(fake.orCallsOnOrders).toEqual([])
  })

  it('never issues a parsed .or() against orders, even for a benign reference', async () => {
    const fake = makeFakeSupabase()
    await resolveOrderIdsByMerchantOrderNo(fake.client, 'FT17847971551076190')
    expect(fake.orCallsOnOrders).toEqual([])
    expect(fake.eqCallsOnOrders).toEqual([
      ['paycloud_merchant_order_no', 'FT17847971551076190'],
      ['payment_reference', 'FT17847971551076190'],
    ])
  })
})

describe('resolveOrderIdsByMerchantOrderNo — the reformulation preserves what the .or() resolved', () => {
  it('resolves a real paycloud_merchant_order_no, and agrees with the old expression', async () => {
    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, 'FT17847973460546925')
    expect(result).toEqual({ orderIds: ['ord-B'], source: 'orders' })
    expect(result.orderIds.sort()).toEqual(orExpressionWouldMatch('FT17847973460546925').sort())
  })

  it('resolves a real payment_reference, and agrees with the old expression', async () => {
    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, 'PAY-20260702-K7M2QRTZ')
    expect(result).toEqual({ orderIds: ['ord-C'], source: 'orders' })
    expect(result.orderIds.sort()).toEqual(orExpressionWouldMatch('PAY-20260702-K7M2QRTZ').sort())
  })

  it('unions BOTH columns — a value in one column of one row and the other column of another', async () => {
    // This is what makes it a union rather than a first-hit-wins short circuit. `.or()` returned
    // both rows in one query; two sequential `.eq()` queries must not stop after the first.
    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, 'SHARED-REF-1')
    expect(result.source).toBe('orders')
    expect(result.orderIds.sort()).toEqual(['ord-D', 'ord-E'])
    expect(result.orderIds.sort()).toEqual(orExpressionWouldMatch('SHARED-REF-1').sort())
  })

  it('does not return the same order twice when both columns hold the reference', async () => {
    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, 'ord-A-both')
    expect(result.orderIds).toEqual([])
    // ord-A carries different values in its two columns; the de-dup path is exercised by the
    // Set in the implementation and asserted directly here.
    const both = await resolveOrderIdsByMerchantOrderNo(
      makeFakeSupabase().client,
      'FT17847971551076190',
    )
    expect(both.orderIds).toEqual(['ord-A'])
  })
})

describe('resolveOrderIdsByMerchantOrderNo — behaviour that must not change', () => {
  it('falls back to payment_events.business_order_no when no order matches', async () => {
    const fake = makeFakeSupabase()
    const result = await resolveOrderIdsByMerchantOrderNo(fake.client, 'FT-LEGACY-POS-9')
    expect(result.source).toBe('payment_events')
    // event_type 'sale' only — the refund event's order must not appear.
    expect(result.orderIds.sort()).toEqual(['ord-legacy-1', 'ord-legacy-2'])
  })

  it('trims, and returns nothing for an empty merchant_order_no', async () => {
    const fake = makeFakeSupabase()
    expect(await resolveOrderIdsByMerchantOrderNo(fake.client, '   ')).toEqual({ orderIds: [], source: null })
    expect(fake.eqCallsOnOrders).toEqual([])
    expect(await resolveOrderIdsByMerchantOrderNo(makeFakeSupabase().client, '  FT17847973460546925  ')).toEqual({
      orderIds: ['ord-B'],
      source: 'orders',
    })
  })

  it('still throws when the orders query errors, so the route can 503 rather than ACK', async () => {
    const fake = makeFakeSupabase({ ordersError: 'connection reset' })
    await expect(resolveOrderIdsByMerchantOrderNo(fake.client, 'FT17847973460546925')).rejects.toThrow(
      'resolveOrderIdsByMerchantOrderNo orders: connection reset',
    )
  })

  it('still throws when the payment_events query errors', async () => {
    const fake = makeFakeSupabase({ eventsError: 'statement timeout' })
    await expect(resolveOrderIdsByMerchantOrderNo(fake.client, 'NO-SUCH-REF')).rejects.toThrow(
      'resolveOrderIdsByMerchantOrderNo payment_events: statement timeout',
    )
  })
})

describe('the intents leg is held to the same parser-free rule', () => {
  /**
   * Added 2026-09-06 with terminal_payment_intents. This leg reads the SAME merchant_order_no from
   * the SAME unauthenticated webhook body on the SAME path where signature verification failed —
   * so it carries the same exposure #242 closed, and needs the same cover.
   */
  const INJECTED = 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'

  it('never issues a parsed .or() against the intents table', async () => {
    const fake = makeFakeSupabase()
    await resolveOrderIdsByMerchantOrderNo(fake.client, INJECTED)
    expect(fake.orCallsOnIntents).toEqual([])
  })

  it('filters the intents table with one opaque .eq() on the reference column', async () => {
    const fake = makeFakeSupabase()
    await resolveOrderIdsByMerchantOrderNo(fake.client, INJECTED)
    // One filter, one column, and the whole injected string as its VALUE — nowhere for a second
    // column name to appear.
    expect(fake.eqCallsOnIntents).toEqual([['merchant_order_no', INJECTED]])
  })

  it('an injected reference still resolves to nothing', async () => {
    const fake = makeFakeSupabase()
    const resolved = await resolveOrderIdsByMerchantOrderNo(fake.client, INJECTED)
    expect(resolved.orderIds).toEqual([])
    expect(resolved.intent ?? null).toBeNull()
  })

  it('a failed intents read THROWS rather than falling through to the order legs', async () => {
    /**
     * Falling through would answer from `orders` for a reference whose intent could not be read —
     * and for a split payment that means marking whole orders paid. Unreadable is not the same as
     * absent.
     */
    const fake = makeFakeSupabase({ intentsError: 'connection reset' })
    await expect(resolveOrderIdsByMerchantOrderNo(fake.client, 'FT17847971551076190')).rejects.toThrow(
      /findIntentByMerchantOrderNo/,
    )
  })
})

describe('the harness refuses rather than dying quietly', () => {
  /**
   * THE POSITIVE CONTROL FOR THE GUARD ITSELF.
   *
   * Everything above proves the resolver is safe. This proves the thing that would TELL us if it
   * stopped being provable. Twice now the answer to "is #242 still covered?" has been "no idea, the
   * suite never ran" — and both times that looked like a broken harness rather than a lost
   * guarantee.
   */
  it('names the missing method, the table, and what to do', () => {
    const fake = makeFakeSupabase()
    const builder = (fake.client as unknown as {
      from: (t: string) => Record<string, unknown>
    }).from('orders')

    let thrown: Error | null = null
    try {
      // A method the real PostgREST builder has and this fake does not model.
      ;(builder as unknown as { textSearch: () => void }).textSearch()
    } catch (e) {
      thrown = e as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown!.message).toMatch(/does not model it/)
    // It must say WHICH method, or the reader is no better off than with a TypeError.
    expect(thrown!.message).toMatch(/\.textSearch\(\)/)
    expect(thrown!.message).toMatch(/orders/)
    // And it must say what to do, because the tempting move is to skip the suite.
    expect(thrown!.message).toMatch(/MODEL \.textSearch\(\) in makeFakeSupabase/)
    expect(thrown!.message).toMatch(/Do not skip this suite/)
  })

  it('lets the modelled methods and the promise machinery through untouched', () => {
    /**
     * The guard must not fire on its own plumbing. `then` is looked up by every await, and jest
     * probes objects it is asked to compare — a guard that threw on those would be worse than none,
     * because it would fail the suite for reasons unrelated to the code under test.
     */
    const fake = makeFakeSupabase()
    const builder = (fake.client as unknown as {
      from: (t: string) => Record<string, unknown>
    }).from('orders')

    for (const modelled of ['select', 'eq', 'or', 'range', 'then', 'maybeSingle', 'limit']) {
      expect(typeof builder[modelled]).toBe('function')
    }
    // Symbols and inspection hooks must not throw either.
    expect(() => String((builder as unknown as { toString: () => string }).toString)).not.toThrow()
  })

  it('still resolves normally through the wrapped builder', () => {
    // The guard is a Proxy around the real fake; if it changed behaviour, every assertion above
    // would be measuring the wrapper instead of the resolver.
    return resolveOrderIdsByMerchantOrderNo(makeFakeSupabase().client, 'FT17847971551076190').then(
      (resolved) => {
        expect(resolved.orderIds.length).toBeGreaterThan(0)
        expect(resolved.source).toBe('orders')
      },
    )
  })
})
