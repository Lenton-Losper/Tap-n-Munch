import type { PostgrestError } from '@supabase/supabase-js'
import type { createServerSupabaseClient } from '@/lib/supabase/server'

type SupabaseServerClient = ReturnType<typeof createServerSupabaseClient>

/**
 * Per-restaurant order numbering (#127).
 *
 * Both allocation sites used to compute `SELECT count(*) + 1` scoped to firebase_restaurant_id and
 * insert that straight into `orders.order_number`, with no unique index behind it. That is wrong
 * twice over:
 *
 *   1. RACE — two staff accepting simultaneously read the same count and insert the same number.
 *   2. REISSUE — count(*)+1 is not correct even single-threaded. Delete one order and the count
 *      drops below max(order_number), so the next order is handed a number that is still in use.
 *
 * The fix has three parts, and all three are needed:
 *
 *   - the partial unique index on (firebase_restaurant_id, order_number), which makes a collision
 *     impossible rather than merely unlikely (migration 20260809120000);
 *   - allocating from max(order_number)+1 instead of count(*)+1, which fixes the reissue bug
 *     outright and shrinks the race to the genuine simultaneous-insert window;
 *   - a bounded retry on the index's own 23505, which closes that window.
 *
 * WHY RETRY, and not a sequence or an advisory lock:
 *
 *   - A Postgres sequence per restaurant would need dynamic DDL on every restaurant created, and
 *     sequences leave permanent gaps on every rollback. Restaurants read these numbers off tickets
 *     and reconcile them by eye; "order 43 then order 47" is a support call.
 *   - An advisory lock cannot help here. The app talks to PostgREST, so allocation and insertion
 *     are two separate round-trips in two separate transactions. A pg_advisory_xact_lock taken
 *     inside an allocator RPC is released the instant that RPC returns — before our INSERT is even
 *     sent — so it would serialise nothing. Holding the lock across both statements would require
 *     an in-database transaction the app does not have.
 *   - A reserve-a-number counter table would be atomic, but it also gaps on every failed insert
 *     and adds a second source of truth that has to be seeded per restaurant and can drift out of
 *     step with the orders it is meant to number.
 *
 * Retry has neither problem: it produces no gaps, keeps `orders` the single source of truth, and
 * the loser of a race simply re-reads the high-water mark and takes the next number. Losing N
 * times in a row requires N genuinely simultaneous inserts in the SAME restaurant, and each round
 * is guaranteed to retire at least one contender, so MAX_ATTEMPTS bounds the worst case rather
 * than gambling on it.
 *
 * On exhaustion the caller gets the 23505 and the order fails. That is the deliberate trade: a
 * failed order that the customer can retry is recoverable, two orders sharing a number on the same
 * pass rail is not.
 */

/** Matches the index name in supabase/migrations/20260809120000_orders_unique_order_number.sql. */
export const ORDER_NUMBER_UNIQUE_INDEX = 'orders_firebase_restaurant_id_order_number_key'

/** Bounds the retry loop. Each round retires at least one contender in a race. */
export const ORDER_NUMBER_MAX_ATTEMPTS = 8

/** Loose on input so the predicate can be pointed at any error object a caller happens to hold. */
interface PostgrestErrorLike {
  code?: string | null
  message?: string | null
  details?: string | null
}

/**
 * True only for a unique violation on the order_number index specifically.
 *
 * Deliberately narrow. `orders` also has unique indexes on idempotency_key, firebase_id and
 * paycloud_merchant_order_no, and those 23505s mean completely different things — an idempotency
 * conflict is a replayed request that must resolve to the ORIGINAL order, never be retried under a
 * new number. Anything this cannot positively identify as a numbering collision is left alone and
 * handled by the caller exactly as before.
 *
 * READS `message` ONLY, AND THAT IS THE SECURITY PROPERTY. PostgREST reports a 23505 as:
 *
 *     message: duplicate key value violates unique constraint "<index name>"
 *     details: Key (<columns>)=(<THE OFFENDING VALUES>) already exists.
 *
 * `details` echoes the caller's own data. This function used to also match the literal
 * "(firebase_restaurant_id, order_number)" anywhere in message+details as a belt-and-braces
 * fallback — and because `idempotencyKey` comes straight off the caller-controlled
 * `x-idempotency-key` header, a request could put that sentinel inside its own idempotency key
 * and make an idempotency conflict read as a numbering collision. The result stayed correct (the
 * retry bound is spent, then createOrder's idempotency handler resolves to the original order),
 * but it cost 8 reads and 8 failing inserts instead of 1 and 1: an 8x amplification on order
 * creation available to anyone who can set a header. Found by the adversarial verification
 * harness on #127.
 *
 * The fallback was never needed — the constraint name in `message` was confirmed against live
 * Postgres on staging — so it is gone rather than merely anchored. `message` contains the index
 * name and nothing else a caller can influence. No `.toLowerCase()` either: the index name is
 * already lowercase, and lowercasing only widens what can match.
 */
export function isOrderNumberCollision(error: PostgrestErrorLike | null | undefined): boolean {
  if (!error || error.code !== '23505') return false
  return String(error.message ?? '').includes(ORDER_NUMBER_UNIQUE_INDEX)
}

/**
 * The next free order number for a restaurant: max(order_number) + 1.
 *
 * `.not('order_number', 'is', null)` is load-bearing, not defensive tidying. Staging carries 127
 * orders rows with a NULL order_number, and a DESC sort in Postgres returns NULLs FIRST — so
 * without the filter the top row is NULL, the maximum reads as 0, and numbering restarts at 1 on
 * top of the restaurant's oldest orders.
 *
 * A read failure throws instead of silently falling back to 1. The old code destructured `count`
 * and ignored the error, so any transient read failure produced order number 1 — a guaranteed
 * duplicate for every restaurant that has ever taken an order.
 */
export async function nextOrderNumber(
  supabase: SupabaseServerClient,
  firebaseRestaurantId: string,
): Promise<number> {
  // A missing scope must fail loudly. PostgREST renders `.eq('firebase_restaurant_id', null)` as
  // `= NULL`, which matches zero rows and returns NO error — so the allocator would read an empty
  // restaurant and hand out 1, duplicating that restaurant's first order. The partial unique
  // index does not cover NULL scopes either, so nothing downstream would catch it. Unreachable
  // from today's callers, but order_requests.firebase_restaurant_id is nullable and the Accept
  // path passes it straight through.
  if (!firebaseRestaurantId) {
    throw new Error(
      'Cannot allocate an order number without a firebase_restaurant_id (restaurant scope missing)',
    )
  }

  const { data, error } = await supabase
    .from('orders')
    .select('order_number')
    .eq('firebase_restaurant_id', firebaseRestaurantId)
    .not('order_number', 'is', null)
    .order('order_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Could not determine the next order number: ${error.message}`)
  }

  const highest = Number(data?.order_number ?? 0)
  return (Number.isFinite(highest) ? highest : 0) + 1
}

export interface AllocatedInsertResult<T> {
  data: T | null
  /** The caller's own error handling is unchanged, so this stays the real PostgrestError. */
  error: PostgrestError | null
  /** How many inserts were attempted; > 1 means the allocator lost a race and recovered. */
  attempts: number
}

/**
 * Insert an order, allocating its order_number and retrying only a collision on that number.
 *
 * `buildRow` is called once per attempt with a freshly read number, so callers cannot accidentally
 * reuse a stale one. Every other error — including a 23505 from any other unique index — is
 * returned to the caller untouched on the first attempt, so existing idempotency handling behaves
 * exactly as it did before.
 */
export async function insertOrderWithAllocatedNumber<T>(
  supabase: SupabaseServerClient,
  firebaseRestaurantId: string,
  selectColumns: string,
  buildRow: (orderNumber: number) => Record<string, unknown>,
): Promise<AllocatedInsertResult<T>> {
  let lastError: PostgrestError | null = null

  for (let attempt = 1; attempt <= ORDER_NUMBER_MAX_ATTEMPTS; attempt++) {
    const orderNumber = await nextOrderNumber(supabase, firebaseRestaurantId)

    const { data, error } = await supabase
      .from('orders')
      .insert(buildRow(orderNumber))
      .select(selectColumns)
      .single()

    if (!isOrderNumberCollision(error)) {
      return { data: (data as T) ?? null, error: error ?? null, attempts: attempt }
    }

    lastError = error
    console.warn('[ORDERS] order_number collision, reallocating', {
      firebaseRestaurantId,
      attemptedOrderNumber: orderNumber,
      attempt,
    })
  }

  console.error('[ORDERS] exhausted order_number allocation attempts', {
    firebaseRestaurantId,
    attempts: ORDER_NUMBER_MAX_ATTEMPTS,
  })
  return { data: null, error: lastError, attempts: ORDER_NUMBER_MAX_ATTEMPTS }
}
