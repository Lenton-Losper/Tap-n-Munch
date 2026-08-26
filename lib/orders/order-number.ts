/**
 * ORDER NUMBER ALLOCATION. One place, because it shipped in three.
 *
 * ============================================================================================
 * #127 — WHAT WAS WRONG, AND IT WAS TWO SEPARATE THINGS
 * ============================================================================================
 *
 * Every allocator in this repo read `SELECT count(*) + 1`:
 *
 *   lib/orders/create-order.ts          count over firebase_restaurant_id      <- the live one
 *   app/api/orders/route.ts             count over firebase_restaurant_id
 *   lib/supabase/orders.ts              count over restaurant_id               <- no callers
 *   app/api/orders/route.ts (kiosk)     count over restaurant + channel + day
 *   .../accept/route.ts    (kiosk)      count over restaurant + channel + day
 *
 * That is a read-then-write with no lock, and it fails in two DIFFERENT ways that need two
 * different fixes. Conflating them is why the record kept saying "the index fixes it".
 *
 * FAILURE 1 — THE RACE. Two writes read the same count and both insert. Nothing in the database
 * objects. Measured on production 2026-08-26: four collisions, all at FNB ChowNow, all POS, all
 * sub-second (187ms, 247ms, 347ms, 407ms), most recent 2026-08-24. `max + 1` does NOT fix this —
 * two racers read the same max just as happily as the same count. Only a UNIQUE INDEX can
 * detect it, and only a retry can recover from it. That is why `insertWithOrderNumber` below is
 * a loop and not a smarter SELECT.
 *
 * FAILURE 2 — THE COUNT IS NOT THE HIGH-WATER MARK. `count(*)` drops when a row leaves the
 * table; `max(order_number)` does not. Delete or archive one order and the next allocation
 * re-issues a number that is still in use, with no concurrency whatever. `max + 1` fixes this
 * one outright.
 *
 * ============================================================================================
 * WHY max+1 GOES IN FIRST, EVEN THOUGH IT IS THE SMALLER HALF
 * ============================================================================================
 *
 * Because the unique index turns failure 2 from a numbering defect into a VENUE OUTAGE, and the
 * two are being deployed in that order.
 *
 * With `count(*)+1` and no index: a deletion makes the next order silently duplicate an existing
 * number. Bad, quiet, recoverable.
 *
 * With `count(*)+1` AND the index: that allocation raises 23505 — and it raises the SAME 23505
 * on every retry and every subsequent order, because count(*) is a deterministic function of a
 * table that is no longer changing. The venue cannot take another order until somebody edits the
 * database. `max+1` cannot enter that state: the number it returns is free by construction.
 *
 * So this file must be deployed BEFORE (or with) the unique index, not after it. The sequencing
 * recorded on #127 puts the allocator change last; that ordering is safe only for as long as no
 * order row is ever deleted, which is not a property anyone is maintaining deliberately.
 *
 * MEASURED: today `count(*)+1` and `max+1` return the SAME number at all four production venues
 * (1466 / 697 / 30 / 16). No order row has ever been deleted, so the two have not yet diverged.
 * This change therefore issues no different number to anybody on the day it ships — it removes a
 * way for them to diverge later. Verified by scripts/prod/probe-127-duplicate-order-numbers.mjs
 * section 7, which prints max-minus-count per venue and reads 0 everywhere.
 *
 * AND THE COLLISIONS ARE WHY IT STAYS 0. Each collision adds one row to the count and burns one
 * number, leaving a gap at number+1 — production's gaps are exactly 315, 421, 449 and 1159,
 * one after each duplicated number. count and max drift apart by +1 and back to 0 in the same
 * moment, which is precisely why this bug has been invisible to a per-venue sanity check.
 *
 * ============================================================================================
 * WHY A BOUNDED RETRY, AND NOT A SEQUENCE / ADVISORY LOCK / COUNTER TABLE
 * ============================================================================================
 *
 * A POSTGRES SEQUENCE is per-object, and order_number is per-restaurant. It would mean one
 * sequence created per venue by DDL at onboarding time — a schema change on the customer-signup
 * path — and a venue whose sequence was not created would fail to take orders at all.
 *
 * AN ADVISORY LOCK (`pg_advisory_xact_lock`) is the textbook answer and it CANNOT BE USED HERE.
 * Every write on this path goes through PostgREST, which does not give the caller a pinned
 * session: the lock and the INSERT would land on different pooled connections, so the lock
 * protects nothing. A transaction-scoped lock needs the INSERT inside the same transaction, and
 * there is no transaction to be inside.
 *
 * A COUNTER TABLE (`UPDATE … SET n = n + 1 RETURNING n`) does work over PostgREST and is the real
 * alternative. It is not used because it introduces a second source of truth for a number that
 * already has one, and the failure it adds is worse than the one it removes: if the counter and
 * the orders table ever disagree — a failed insert after a successful increment, a restore, a
 * manual edit — every subsequent order is numbered wrongly and nothing detects it. `max+1` is
 * self-correcting by definition; it cannot drift from the table it reads.
 *
 * THE RETRY. Read max, insert, and if the unique index rejects it, read max again and insert
 * again. Under contention the loser's second read sees the winner's row, so the loop converges
 * in one extra round trip rather than backing off. Bounded at ORDER_NUMBER_MAX_ATTEMPTS so a
 * genuine fault — a stuck index, a mis-scoped constraint — surfaces as an error instead of
 * spinning.
 *
 * THE RETRY IS INERT WITHOUT THE INDEX. On production today there is no unique index on
 * (firebase_restaurant_id, order_number), so a collision produces no error and the loop runs
 * exactly once. That is not a reason to wait: the loop costs nothing until the index exists, and
 * shipping it first is what stops the index from being the thing that breaks a venue.
 *
 * ============================================================================================
 * THE SCOPE COLUMN
 * ============================================================================================
 *
 * `firebase_restaurant_id`, matching `20260809120000_orders_unique_order_number.sql` and the
 * allocator it replaces. Not restaurant_id, even though restaurant_id is the modern key: the
 * allocator and the index MUST agree, and the index's scope is a recorded decision.
 *
 * Measured on production 2026-08-26, they are exactly interchangeable for real data — zero
 * firebase ids spanning two restaurants, zero restaurants with two firebase ids, zero real rows
 * carrying one and not the other. The ONLY difference is #324's 1314 stress fixtures, which hold
 * a firebase id and a NULL restaurant_id: they collide on the firebase key (941 blocking rows)
 * and cannot collide on the restaurant_id key, because Postgres treats NULLs as distinct. That
 * difference is what makes #324 a prerequisite for the firebase-scoped index and not for the
 * other. It is a decision for whoever owns the index, and it is recorded here rather than taken.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAllocatedOrderNumber } from '@/lib/orders/order-identity'

/**
 * The unique index the retry is listening for, by name.
 *
 * MATCHING BY NAME AND NOT BY CODE ALONE IS THE WHOLE POINT. `orders` carries four other unique
 * indexes, and `idempotency_key` raises 23505 on a path that is ALREADY handled — by looking the
 * existing order up and returning it, which is correct and must not become a retry. A bare
 * `code === '23505'` test would swallow that case and re-insert a duplicate order.
 */
export const ORDER_NUMBER_UNIQUE_INDEX = 'orders_firebase_restaurant_id_order_number_key'

/**
 * How many times to re-read and re-insert before giving up.
 *
 * Six because each attempt costs one extra round trip and loses only to a writer that committed
 * in between; six consecutive losses is not contention, it is a fault worth surfacing.
 */
export const ORDER_NUMBER_MAX_ATTEMPTS = 6

/** The subset of a PostgREST error this module reasons about. */
export type OrderNumberError = {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

/**
 * What an insert attempt hands back. Deliberately the shape supabase-js already returns, so a
 * `.insert(...).select(...).single()` chain can be handed over verbatim.
 *
 * The callback is typed `PromiseLike`, not `Promise`: a PostgREST builder is a thenable and is
 * NOT a Promise, so requiring one rejects every real call site at compile time.
 */
export type OrderInsertOutcome<T> = { data: T | null; error: OrderNumberError | null }

/**
 * Is this error the order-number unique index rejecting our allocation?
 *
 * Returns false for every other 23505 — see ORDER_NUMBER_UNIQUE_INDEX.
 */
export function isOrderNumberCollision(error: OrderNumberError | null | undefined): boolean {
  if (!error || error.code !== '23505') return false
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
  return text.includes(ORDER_NUMBER_UNIQUE_INDEX)
}

/**
 * The next free order number for a venue: max(order_number) + 1, scoped by firebase id.
 *
 * TWO NULL TRAPS, both live.
 *
 * 1. `.order('order_number', { ascending: false })` alone puts NULLs FIRST in PostgREST, so the
 *    first row of a descending sort is a NULL one and the max reads as "no orders". Production
 *    has one order row with a NULL order_number today, and staging has 127. `nullsFirst: false`
 *    is not tidiness — without it this function returns 1 for a venue with 1465 orders.
 * 2. The explicit `.not('order_number', 'is', null)` filter says the same thing a second way, so
 *    the correctness does not rest on a sort option that a future refactor could drop as noise.
 *
 * A venue with no numbered orders gets 1, which is where allocation has always started.
 */
export async function nextOrderNumber(
  supabase: SupabaseClient,
  firebaseRestaurantId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('orders')
    .select('order_number')
    .eq('firebase_restaurant_id', firebaseRestaurantId)
    .not('order_number', 'is', null)
    .order('order_number', { ascending: false, nullsFirst: false })
    .limit(1)

  if (error) throw new Error(`Could not read the highest order number: ${error.message}`)

  /*
   * `hasAllocatedOrderNumber` and not a `?? 0` fallback, and this is not a formality.
   *
   * The first draft here was `Number(data?.[0]?.order_number ?? 0)`, and
   * scripts/check-order-number-guard.ts refused it — correctly. That is the exact coercion that
   * produced "Order #0" on a customer's screen (#296), and it fails the same way here for a
   * different reason: a row whose order_number came back as '' or 0 would be treated as a
   * high-water mark of zero and the next order would be allocated #1, on top of a venue that
   * already has fourteen hundred.
   *
   * The guard was NOT allow-listed to let the original line through. A gate that gets an
   * exemption the first time it fires is not a gate.
   */
  const highest = data?.[0] ?? null
  const base = hasAllocatedOrderNumber(highest) ? Number(highest?.order_number) : 0
  return base + 1
}

/**
 * Allocate a number, insert, and retry the pair if the unique index says somebody beat us.
 *
 * The caller supplies the insert as a callback taking the number, so everything expensive and
 * everything with a side effect — pricing, item enrichment, the request claim — happens ONCE,
 * outside the loop. Only the allocate-and-insert pair repeats.
 *
 * The final `{ data, error }` is returned rather than thrown so the caller's existing error
 * handling is untouched. In particular `create-order.ts` still gets its idempotency-key 23505
 * verbatim and still resolves it by looking the order up — that path never reaches the retry,
 * because `isOrderNumberCollision` names the index.
 */
export async function insertWithOrderNumber<R extends OrderInsertOutcome<unknown>>(
  supabase: SupabaseClient,
  firebaseRestaurantId: string,
  insert: (orderNumber: number) => PromiseLike<R>,
): Promise<R & { orderNumber: number; attempts: number }> {
  /*
   * GENERIC OVER THE WHOLE RESULT, NOT OVER THE ROW.
   *
   * supabase-js returns a UNION — `{ data: Row; error: null } | { data: null; error: PostgrestError }`
   * — so a signature written as `PromiseLike<{ data: T | null, ... }>` infers `T` from both arms at
   * once and lands on `never`, which then reports every field of the returned row as missing. The
   * error reads like the row type is wrong; it is the inference site that is wrong. Taking the
   * result type whole and constraining it keeps the caller's own row type intact.
   */
  let last: R | undefined
  let orderNumber = 0

  for (let attempt = 1; attempt <= ORDER_NUMBER_MAX_ATTEMPTS; attempt += 1) {
    orderNumber = await nextOrderNumber(supabase, firebaseRestaurantId)
    last = await insert(orderNumber)

    if (!isOrderNumberCollision(last.error)) {
      return { ...last, orderNumber, attempts: attempt }
    }

    console.warn(
      `[ORDER_NUMBER] #${orderNumber} was taken at ${firebaseRestaurantId} — ` +
        `attempt ${attempt}/${ORDER_NUMBER_MAX_ATTEMPTS}, re-reading and retrying.`,
    )
  }

  // Every attempt lost. Hand the collision back rather than inventing a number: a caller that
  // sees this has a real fault, and an order it must not pretend to have created.
  return { ...(last as R), orderNumber, attempts: ORDER_NUMBER_MAX_ATTEMPTS }
}

/**
 * The kiosk counter — a per-restaurant, per-DAY number shown on the kiosk ticket as K-nnn.
 *
 * SAME SHAPE, DIFFERENT STATE OF REPAIR, AND THIS IS NOT HIDDEN. The count-versus-high-water-mark
 * half is fixed here exactly as above. THE RACE IS NOT FIXED: there is no unique index on
 * (restaurant_id, day, kiosk_order_number) on either environment, so two kiosk orders accepted in
 * the same moment still both get K-004 and nothing objects.
 *
 * No index is proposed for it in the same breath because the evidence to design one does not
 * exist yet. Production carries EIGHT rows with a kiosk_order_number, total, ever. The zero
 * duplicates measured among them is a statement about eight rows, not a clean bill of health —
 * this is an untested path, not a safe one, and a unique index over a date expression is a real
 * decision (which day boundary, whose timezone) that eight rows cannot inform.
 *
 * The day boundary here is UTC, unchanged from the two call sites this replaces. Namibia is
 * UTC+2, so the counter currently rolls over at 02:00 local — a defect this function inherits
 * deliberately rather than silently repairing inside a numbering fix.
 */
export async function nextKioskOrderNumber(
  supabase: SupabaseClient,
  restaurantId: string,
  now: Date = new Date(),
): Promise<number> {
  const dayStart = `${now.toISOString().split('T')[0]}T00:00:00Z`

  const { data, error } = await supabase
    .from('orders')
    .select('kiosk_order_number')
    .eq('restaurant_id', restaurantId)
    .eq('channel', 'kiosk')
    .gte('placed_at', dayStart)
    .not('kiosk_order_number', 'is', null)
    .order('kiosk_order_number', { ascending: false, nullsFirst: false })
    .limit(1)

  if (error) throw new Error(`Could not read the highest kiosk number: ${error.message}`)

  const highest = Number(data?.[0]?.kiosk_order_number ?? 0)
  return (Number.isFinite(highest) ? highest : 0) + 1
}

/** The K-nnn label, so the two call sites cannot pad it differently. */
export function kioskOrderLabel(kioskOrderNumber: number): string {
  return `K-${String(kioskOrderNumber).padStart(3, '0')}`
}
