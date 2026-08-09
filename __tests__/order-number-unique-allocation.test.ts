/**
 * Issue #127 — two orders in the same restaurant could be given the same order_number.
 *
 * `order_number` was derived from `SELECT count(*) + 1` scoped to firebase_restaurant_id, at two
 * sites (lib/orders/create-order.ts and app/api/orders/route.ts), and NOTHING in the database
 * stopped the result from colliding: the only unique indexes on `orders` were firebase_id,
 * idempotency_key and paycloud_merchant_order_no.
 *
 * count(*)+1 is wrong in two independent ways:
 *
 *   1. RACE. Two staff accepting at the same moment both read the same count and both insert.
 *   2. REISSUE. It is not even correct single-threaded. Delete any row and count(*)+1 drops back
 *      below max(order_number), so the very next order is handed a number already in use. No
 *      concurrency needed — one deleted order is enough. Staging's live suites delete orders
 *      routinely, so this is not hypothetical.
 *
 * These tests run against a fake Supabase client that models the orders table AS IT IS AFTER the
 * accompanying migration: the partial unique index on (firebase_restaurant_id, order_number) is
 * enforced, exactly as Postgres enforces it, and a 23505 is raised with the real constraint name.
 * That is deliberate — with the index in place a bad allocation stops being a silent duplicate and
 * becomes a FAILED ORDER, so the allocator has to be right, not merely constrained.
 */
import { createOrder } from '@/lib/orders/create-order'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OTHER_RESTAURANT_UUID = 'b2888277-eeab-51e2-be2e-3f12393b2763'

const ORDER_NUMBER_INDEX = 'orders_firebase_restaurant_id_order_number_key'
/**
 * The real name, from supabase/migrations/00000000000000_baseline.sql:1717.
 *
 * Note `orders` carries TWO unique indexes on (idempotency_key) with identical definitions —
 * `idx_orders_idempotency_key` and `orders_idempotency_key_unique` (baseline.sql:1822) — so which
 * name appears in a 23505 depends on which index Postgres checks first. That redundancy is a
 * separate defect, reported and not fixed here; it is also exactly why isOrderNumberCollision
 * identifies its OWN index by name rather than trying to recognise everyone else's.
 */
const IDEMPOTENCY_INDEX = 'idx_orders_idempotency_key'

type Row = Record<string, unknown>

interface State {
  rows: Row[]
  nextId: number
  insertAttempts: Row[]
  /** Runs immediately before an insert is evaluated — lets a test land a competing row first. */
  beforeInsert: ((row: Row, attempt: number) => void) | null
}

let state: State

jest.mock('@/lib/orders/calculate-order-pricing', () => ({
  calculateOrderPricing: async (_c: unknown, _r: string, items: unknown[]) => ({
    items,
    subtotal: 100,
    tax: 15,
    total: 115,
    warnings: [],
  }),
  UnmatchedMenuItemError: class UnmatchedMenuItemError extends Error {},
}))

/** A PostgrestError shaped the way PostgREST actually reports a unique violation. */
function uniqueViolation(constraint: string, detail: string) {
  return {
    code: '23505',
    message: `duplicate key value violates unique constraint "${constraint}"`,
    details: `Key ${detail} already exists.`,
    hint: null,
  }
}

/** The two unique indexes on `orders` that matter here, enforced the way Postgres enforces them. */
function checkUniqueIndexes(row: Row) {
  const scope = row.firebase_restaurant_id
  const number = row.order_number
  // Partial index: NULL in either column is exempt, matching `WHERE ... IS NOT NULL`.
  if (scope != null && number != null) {
    if (state.rows.some((r) => r.firebase_restaurant_id === scope && r.order_number === number)) {
      return uniqueViolation(
        ORDER_NUMBER_INDEX,
        `(firebase_restaurant_id, order_number)=(${String(scope)}, ${String(number)})`,
      )
    }
  }
  if (row.idempotency_key != null) {
    if (state.rows.some((r) => r.idempotency_key === row.idempotency_key)) {
      return uniqueViolation(IDEMPOTENCY_INDEX, `(idempotency_key)=(${String(row.idempotency_key)})`)
    }
  }
  return null
}

interface Filter {
  kind: 'eq' | 'notNull'
  column: string
  value?: unknown
}

/**
 * A query builder faithful to the shapes these two call sites use, and LOUD about anything else:
 * a fake that quietly ignores a filter it does not understand would report a passing test for an
 * allocator that is actually reading the wrong rows.
 */
class Builder implements PromiseLike<unknown> {
  private filters: Filter[] = []
  private headCount = false
  private orderBy: { column: string; ascending: boolean } | null = null
  private limitTo: number | null = null

  constructor(private table: string) {
    if (table !== 'orders') throw new Error(`fake client: unexpected table "${table}"`)
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.headCount = Boolean(options?.head)
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }

  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) {
      throw new Error(`fake client: unsupported .not(${column}, ${operator}, ${String(value)})`)
    }
    this.filters.push({ kind: 'notNull', column })
    return this
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false }
    return this
  }

  limit(n: number) {
    this.limitTo = n
    return this
  }

  private matching(): Row[] {
    let out = state.rows.filter((r) =>
      this.filters.every((f) =>
        f.kind === 'eq' ? r[f.column] === f.value : r[f.column] !== null && r[f.column] !== undefined,
      ),
    )
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      out = [...out].sort((a, b) => {
        const av = a[column] as number
        const bv = b[column] as number
        // Postgres puts NULLs FIRST on a DESC sort unless told otherwise; reproduce that, because
        // an allocator that forgets it reads NULL as the maximum and restarts numbering at 1.
        if (av == null && bv == null) return 0
        if (av == null) return ascending ? 1 : -1
        if (bv == null) return ascending ? -1 : 1
        return ascending ? av - bv : bv - av
      })
    }
    if (this.limitTo != null) out = out.slice(0, this.limitTo)
    return out
  }

  async maybeSingle() {
    const rows = this.matching()
    return { data: rows[0] ?? null, error: null }
  }

  async single() {
    const rows = this.matching()
    if (rows.length !== 1) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows', details: '', hint: null } }
    }
    return { data: rows[0], error: null }
  }

  /** `.select('*', { count: 'exact', head: true }).eq(...)` is awaited directly. */
  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.matching()
    const result = this.headCount
      ? { data: null, count: rows.length, error: null }
      : { data: rows, count: null, error: null }
    return Promise.resolve(result).then(onfulfilled, onrejected)
  }

  insert(row: Row) {
    const attempt = state.insertAttempts.length + 1
    state.insertAttempts.push({ ...row })
    state.beforeInsert?.(row, attempt)

    const violation = checkUniqueIndexes(row)
    const stored: Row | null = violation
      ? null
      : (() => {
          const created = { id: `order-${state.nextId++}`, ...row }
          state.rows.push(created)
          return created
        })()

    const result = { data: stored, error: violation }
    return {
      select: () => ({
        single: async () => result,
        maybeSingle: async () => result,
      }),
    }
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({ from: (table: string) => new Builder(table) }),
}))

/** Seed an existing order without going through the allocator. */
function seed(scope: string, orderNumber: number | null, extra: Row = {}) {
  state.rows.push({
    id: `seed-${state.rows.length + 1}`,
    firebase_restaurant_id: scope,
    restaurant_id: scope,
    order_number: orderNumber,
    payment_status: 'pending',
    idempotency_key: null,
    ...extra,
  })
}

function params(overrides: Partial<Parameters<typeof createOrder>[0]> = {}) {
  return {
    restaurantId: RESTAURANT_UUID,
    firebaseRestaurantId: RESTAURANT_UUID,
    tableNumber: 7,
    tableId: null,
    sessionId: null,
    items: [{ menuItemId: 'item-1', quantity: 1 }],
    subtotal: 100,
    total: 115,
    paymentMethod: 'card',
    paymentChannel: null,
    paymentStatus: 'pending',
    orderInstructions: null,
    tabId: null,
    channel: 'pos',
    customerName: null,
    idempotencyKey: null,
    memberSessionId: null,
    tabSettlementForTabId: null,
    ...overrides,
  }
}

beforeEach(() => {
  state = { rows: [], nextId: 1, insertAttempts: [], beforeInsert: null }
})

describe('#127 — order_number allocation cannot collide', () => {
  it('never reissues a number that is already taken, even when rows have been deleted', async () => {
    // 1,2,3,4,5 were issued; 2 and 3 were later deleted. count(*)+1 = 4, which order 4 has.
    seed(RESTAURANT_UUID, 1)
    seed(RESTAURANT_UUID, 4)
    seed(RESTAURANT_UUID, 5)

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(6)
  })

  it('allocates from the high-water mark, not the row count', async () => {
    seed(RESTAURANT_UUID, 10)

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(11)
  })

  it('recovers when a concurrent order takes the number first', async () => {
    // The exact #127 race: both requests read the same high-water mark, the other one commits
    // first. Ours must come back with the next free number, NOT fail and NOT duplicate.
    seed(RESTAURANT_UUID, 41)
    state.beforeInsert = (row, attempt) => {
      if (attempt === 1) seed(RESTAURANT_UUID, row.order_number as number)
    }

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(43)
    expect(state.rows.filter((r) => r.order_number === 42)).toHaveLength(1)
  })

  it('survives several consecutive losses of the race', async () => {
    seed(RESTAURANT_UUID, 1)
    state.beforeInsert = (row, attempt) => {
      if (attempt <= 3) seed(RESTAURANT_UUID, row.order_number as number)
    }

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(5)
  })

  it('numbers each restaurant independently', async () => {
    seed(OTHER_RESTAURANT_UUID, 900)
    seed(RESTAURANT_UUID, 3)

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(4)
  })

  it('starts at 1 for a restaurant with no orders', async () => {
    const result = await createOrder(params())

    expect(result.orderNumber).toBe(1)
  })

  it('ignores rows whose order_number is NULL when finding the high-water mark', async () => {
    // A DESC sort returns NULLs first in Postgres. Reading one as the maximum would restart
    // numbering at 1 and collide with the oldest order in the restaurant.
    seed(RESTAURANT_UUID, null)
    seed(RESTAURANT_UUID, 12)

    const result = await createOrder(params())

    expect(result.orderNumber).toBe(13)
  })

  it('still resolves an idempotency-key duplicate to the existing order', async () => {
    // Guard on the behaviour that must NOT change: a 23505 from the idempotency index is a
    // replayed request, not a numbering collision, and must return the original order rather
    // than being retried with a new number.
    seed(RESTAURANT_UUID, 8, { idempotency_key: 'key-abc', id: 'original-order' })

    const result = await createOrder(params({ idempotencyKey: 'key-abc' }))

    expect(result.orderId).toBe('original-order')
    expect(result.orderNumber).toBe(8)
    // One insert attempt: an idempotency conflict is resolved, never retried.
    expect(state.insertAttempts).toHaveLength(1)
  })
})

describe('#127 follow-up — the collision predicate must not be spoofable', () => {
  /**
   * Found by the adversarial verification harness, not by me.
   *
   * isOrderNumberCollision originally matched on `message + details`, with a fallback branch
   * looking for the literal "(firebase_restaurant_id, order_number)". PostgREST echoes the
   * offending VALUE into `details` on a 23505 -- `Key (idempotency_key)=(<the key>) already
   * exists.` -- and idempotencyKey comes straight off the caller-controlled `x-idempotency-key`
   * header. So a caller could put the sentinel inside its own idempotency key and make an
   * idempotency conflict look like a numbering collision.
   *
   * The end state stayed correct, which is why nothing else caught it: the bound is spent, the
   * helper returns the idempotency 23505, and createOrder's existing handler resolves to the
   * original order. The damage is 8 reads plus 8 failing inserts where 1 and 1 would do -- an
   * 8x amplification on order creation, triggerable by anyone who can set a header.
   *
   * The fix reads only `message`, which is `duplicate key value violates unique constraint
   * "<name>"` and carries no caller data.
   */
  const SPOOF_KEY = 'X(firebase_restaurant_id, order_number)X'

  it('does not retry an idempotency conflict whose KEY spoofs the collision sentinel', async () => {
    seed(RESTAURANT_UUID, 8, { idempotency_key: SPOOF_KEY, id: 'original-order' })

    const result = await createOrder(params({ idempotencyKey: SPOOF_KEY }))

    expect(state.insertAttempts).toHaveLength(1)
    expect(result.orderId).toBe('original-order')
    expect(result.orderNumber).toBe(8)
  })

  it('CONTROL: a genuine order_number 23505 is still detected and still retried', async () => {
    // Without this, a predicate tightened until it matches NOTHING would pass every other test
    // in this file — a collision detector that never fires looks identical to a correct one.
    seed(RESTAURANT_UUID, 41)
    state.beforeInsert = (row, attempt) => {
      if (attempt === 1) seed(RESTAURANT_UUID, row.order_number as number)
    }

    const result = await createOrder(params())

    expect(state.insertAttempts.length).toBeGreaterThan(1)
    expect(result.orderNumber).toBe(43)
  })
})

describe('#127 follow-up — a missing restaurant scope must not silently allocate 1', () => {
  it('throws rather than returning order number 1 for a null scope', async () => {
    // `.eq('firebase_restaurant_id', null)` matches zero rows WITHOUT an error, so the allocator
    // read an empty restaurant and handed out 1 — a duplicate of that restaurant's first order.
    // The partial unique index does not cover NULL scopes either, so nothing downstream catches
    // it. Unreachable from today's callers, but order_requests.firebase_restaurant_id is a
    // nullable text column and the Accept path passes it through unguarded.
    await expect(
      createOrder(params({ firebaseRestaurantId: null as unknown as string })),
    ).rejects.toThrow(/restaurant/i)

    expect(state.insertAttempts).toHaveLength(0)
  })

  it('throws on an empty-string scope too', async () => {
    await expect(createOrder(params({ firebaseRestaurantId: '' }))).rejects.toThrow(/restaurant/i)
    expect(state.insertAttempts).toHaveLength(0)
  })
})
