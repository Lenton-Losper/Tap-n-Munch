/**
 * #127 — the order-number allocator, driven for real against a fake PostgREST.
 *
 * ============================================================================================
 * WHAT MAKES THESE ASSERTIONS BITE
 * ============================================================================================
 *
 * NOTHING HERE RECOMPUTES AN ORDER NUMBER. A test that derives the expected number the same way
 * the code does proves only that the copy agrees with the original. So the fake database is set
 * up so that COUNT AND MAX DISAGREE — 1461 rows, highest number 1465, which is production's
 * actual shape at FNB ChowNow, where four collisions burned four numbers. `count(*) + 1` returns
 * 1462 and `max + 1` returns 1466, and the expected value is written as the literal 1466. Revert
 * the allocator to a count and the number is wrong by four.
 *
 * That divergence is the whole design of this file. Against a table with no gaps the two
 * allocators are indistinguishable, which is exactly why the defect survived on production for
 * months: `count + 1` and `max + 1` still return the same number at all four live venues today.
 *
 * THE FAKE IS A FAKE DATABASE, NOT A FAKE ALLOCATOR. It holds rows and answers queries about
 * them. `nextOrderNumber` and `insertWithOrderNumber` are the real functions, unmocked.
 *
 * ============================================================================================
 * WHAT THESE TESTS CANNOT SEE, STATED RATHER THAN IMPLIED
 * ============================================================================================
 *
 * The NULL-ordering trap is asserted by inspecting the query that was built, not by observing
 * PostgREST sort NULLs. PostgREST puts NULLs FIRST in a descending sort, so
 * `.order('order_number', { ascending: false })` without `nullsFirst: false` reads the max as
 * NULL for any venue with an unnumbered row — production has one, staging has 127. A fake cannot
 * reproduce a server-side sort convention, so that one test pins the CALL and says so. It would
 * survive a change that kept the arguments and broke the meaning.
 *
 * Nothing here proves two concurrent HTTP requests cannot collide. That needs the unique index
 * and two real connections. What is proved is the recovery: given a collision reported by the
 * index, the allocator re-reads and re-inserts rather than failing or duplicating.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ORDER_NUMBER_MAX_ATTEMPTS,
  ORDER_NUMBER_UNIQUE_INDEX,
  insertWithOrderNumber,
  isOrderNumberCollision,
  nextOrderNumber,
} from '@/lib/orders/order-number'

const VENUE = 'b161c758-582d-4dfa-839a-9fa35c492a49'

/** Production's shape at FNB ChowNow: 1461 distinct numbers, highest 1465, four burnt by collisions. */
const ROW_COUNT = 1461
const HIGHEST_NUMBER = 1465
const EXPECTED_ALLOCATION = 1466

type QueryRecord = { table: string; calls: Array<[string, unknown[]]> }

/**
 * A fake PostgREST that answers "what is the highest order_number" from a settable value and
 * records how it was asked. `head`-style count reads answer with ROW_COUNT, so an allocator that
 * counts gets a different — and wrong — answer rather than an error.
 */
function makeClient(state: { highest: number | null }) {
  const queries: QueryRecord[] = []

  function builder(table: string) {
    const record: QueryRecord = { table, calls: [] }
    queries.push(record)

    const api: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => {
      record.calls.push([name, args])
      return api
    }

    Object.assign(api, {
      select: (columns: string, options?: { count?: string; head?: boolean }) => {
        record.calls.push(['select', [columns, options]])
        return api
      },
      eq: chain('eq'),
      gte: chain('gte'),
      not: chain('not'),
      order: chain('order'),
      limit: chain('limit'),
      then: (resolve: (r: unknown) => unknown) => {
        const counted = record.calls.some(
          ([name, args]) => name === 'select' && (args[1] as { count?: string } | undefined)?.count,
        )
        if (counted) return Promise.resolve(resolve({ count: ROW_COUNT, data: null, error: null }))
        const column = record.calls.some(([n, a]) => n === 'select' && String(a[0]).includes('kiosk'))
          ? 'kiosk_order_number'
          : 'order_number'
        const data = state.highest == null ? [] : [{ [column]: state.highest }]
        return Promise.resolve(resolve({ data, error: null }))
      },
    })
    return api
  }

  return {
    client: { from: (table: string) => builder(table) } as unknown as SupabaseClient,
    queries,
  }
}

type InsertResult = {
  data: { id: string; order_number: number } | null
  error: { code: string; message: string; details: null; hint: null } | null
}

const collision = (index: string) => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${index}"`,
  details: null,
  hint: null,
})

describe('nextOrderNumber', () => {
  it('returns the high-water mark plus one, not the row count plus one', async () => {
    const { client } = makeClient({ highest: HIGHEST_NUMBER })

    // 1466, written as a literal. The fake would answer a count query with 1461.
    await expect(nextOrderNumber(client, VENUE)).resolves.toBe(EXPECTED_ALLOCATION)
  })

  it('starts a venue with no numbered orders at 1', async () => {
    const { client } = makeClient({ highest: null })
    await expect(nextOrderNumber(client, VENUE)).resolves.toBe(1)
  })

  it('asks the database to exclude NULL order numbers, and not to sort them first', async () => {
    // Pins the QUERY, not the behaviour — see the file docblock. Without both of these a venue
    // with one unnumbered row reads as having no orders at all.
    const { client, queries } = makeClient({ highest: HIGHEST_NUMBER })
    await nextOrderNumber(client, VENUE)

    const query = queries.find((q) => q.table === 'orders')
    expect(query).toBeDefined()
    expect(query!.calls).toContainEqual(['not', ['order_number', 'is', null]])
    expect(query!.calls).toContainEqual([
      'order',
      ['order_number', { ascending: false, nullsFirst: false }],
    ])
  })
})

describe('isOrderNumberCollision', () => {
  it('recognises the order-number unique index', () => {
    expect(isOrderNumberCollision(collision(ORDER_NUMBER_UNIQUE_INDEX))).toBe(true)
  })

  it('does NOT claim the idempotency-key violation — that path returns the existing order', () => {
    expect(isOrderNumberCollision(collision('orders_idempotency_key_unique'))).toBe(false)
    expect(isOrderNumberCollision(collision('orders_paycloud_merchant_order_no_unique'))).toBe(false)
  })

  it('ignores errors that are not unique violations', () => {
    expect(isOrderNumberCollision({ code: '23503', message: ORDER_NUMBER_UNIQUE_INDEX })).toBe(false)
    expect(isOrderNumberCollision(null)).toBe(false)
  })
})

describe('insertWithOrderNumber', () => {
  it('inserts once with max+1 when nothing collides', async () => {
    const { client } = makeClient({ highest: HIGHEST_NUMBER })
    const seen: number[] = []

    const result = await insertWithOrderNumber(client, VENUE, (orderNumber) => {
      seen.push(orderNumber)
      return Promise.resolve({ data: { id: 'order-1', order_number: orderNumber }, error: null })
    })

    expect(seen).toEqual([EXPECTED_ALLOCATION])
    expect(result.attempts).toBe(1)
    expect(result.orderNumber).toBe(EXPECTED_ALLOCATION)
    expect(result.data).toEqual({ id: 'order-1', order_number: EXPECTED_ALLOCATION })
    expect(result.error).toBeNull()
  })

  it('re-reads and retries when the unique index says the number was taken', async () => {
    // The race, as the loser experiences it: our 1466 is rejected because the winner committed
    // it, and by the time we look again the winner's row IS the new high-water mark.
    const state = { highest: HIGHEST_NUMBER }
    const { client } = makeClient(state)
    const seen: number[] = []

    const result = await insertWithOrderNumber(client, VENUE, (orderNumber): Promise<InsertResult> => {
      seen.push(orderNumber)
      if (seen.length === 1) {
        state.highest = orderNumber // the winner's row is now visible
        return Promise.resolve({ data: null, error: collision(ORDER_NUMBER_UNIQUE_INDEX) })
      }
      return Promise.resolve({ data: { id: 'order-2', order_number: orderNumber }, error: null })
    })

    expect(seen).toEqual([1466, 1467])
    expect(result.attempts).toBe(2)
    expect(result.orderNumber).toBe(1467)
    expect(result.error).toBeNull()
  })

  it('hands an idempotency-key violation straight back, unretried', async () => {
    // If this retried, an order submitted twice with one idempotency key would be inserted
    // twice under two numbers instead of resolving to the order that already exists.
    const { client } = makeClient({ highest: HIGHEST_NUMBER })
    let attempts = 0

    const result = await insertWithOrderNumber(client, VENUE, () => {
      attempts += 1
      return Promise.resolve({ data: null, error: collision('orders_idempotency_key_unique') })
    })

    expect(attempts).toBe(1)
    expect(result.attempts).toBe(1)
    expect(result.error?.code).toBe('23505')
  })

  it('gives up after a bounded number of collisions instead of spinning', async () => {
    const { client } = makeClient({ highest: HIGHEST_NUMBER })
    let attempts = 0

    const result = await insertWithOrderNumber(client, VENUE, () => {
      attempts += 1
      return Promise.resolve({ data: null, error: collision(ORDER_NUMBER_UNIQUE_INDEX) })
    })

    expect(attempts).toBe(ORDER_NUMBER_MAX_ATTEMPTS)
    expect(result.data).toBeNull()
    expect(result.error).not.toBeNull()
  })
})
