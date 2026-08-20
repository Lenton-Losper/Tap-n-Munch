/**
 * THE ONE WAY TO READ A SET THAT CAN EXCEED 1000 ROWS.
 *
 * PostgREST caps a response at 1000 rows and says nothing about it: no error, no flag, no partial
 * indicator. A read without an explicit `.range()` therefore returns a truncated set that looks
 * complete, and every total derived from it is quietly wrong.
 *
 * That is #323. `totalRevenue`, `totalOrders` and `avgOrderValue` in Order History were summed from
 * an unpaginated query, so past 1000 paid orders in the window they under-reported -- a number a
 * restaurant would have acted on, with nothing on screen to say it was short. Reproduced on staging:
 * 1220 paid orders in the window, 1000 returned.
 *
 * FOUR SITES HAD THEIR OWN VERSION OF THIS PROBLEM AND NONE HAD A LOOP. Writing four bespoke loops
 * would have left the next author to invent a fifth, so there is exactly one helper and
 * scripts/check-orders-read-bounded.ts fails the build on any unbounded read that does not use it.
 *
 * WHY THE LOOP IS SHAPED THIS WAY:
 *
 *   - it stops on a SHORT page, not on an empty one, which saves a final wasted round trip
 *   - it has a hard ceiling (`maxRows`), because an unbounded loop against an unexpectedly huge
 *     table is its own outage; crossing it THROWS rather than returning a quietly truncated set,
 *     since returning short is the exact failure this helper exists to prevent
 *   - `pageSize` defaults to 1000 to match the server cap: a larger value is silently clamped by
 *     PostgREST, which would make the short-page test never fire and the loop never terminate
 */

/** The server-side cap. Requesting more per page does not raise it. */
export const POSTGREST_MAX_ROWS = 1000

export type FetchAllOptions = {
  /** Rows per request. Clamped to POSTGREST_MAX_ROWS, because the server clamps it anyway. */
  pageSize?: number
  /**
   * Safety ceiling. Exceeding it throws rather than returning a short set -- a truncated total is
   * the failure being prevented, so it must never be the quiet outcome.
   */
  maxRows?: number
  /** Included in the error message when maxRows is hit, so the throw names its own caller. */
  label?: string
}

/**
 * A PostgREST builder that can still take `.range()`. Deliberately structural: the Supabase client
 * types differ between the service-role and session clients, and every caller here passes one or
 * the other.
 */
export type RangeableQuery<Row> = {
  range: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>
}

/**
 * Read every row a query matches, paging until exhausted.
 *
 * Pass a builder that has NOT yet been awaited and has no `.range()` of its own:
 *
 *     const rows = await fetchAllRows(
 *       supabase.from('orders').select('id, total').eq('restaurant_id', id),
 *     )
 *
 * Supabase builders are thenable, so awaiting one sends it. This never awaits the builder itself --
 * only `.range()` results -- which is what makes re-ranging the same builder safe.
 */
export async function fetchAllRows<Row>(
  query: RangeableQuery<Row>,
  options: FetchAllOptions = {},
): Promise<Row[]> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? POSTGREST_MAX_ROWS), POSTGREST_MAX_ROWS)
  const maxRows = options.maxRows ?? 50_000
  const label = options.label ?? 'fetchAllRows'

  const rows: Row[] = []
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1)
    if (error) throw new Error(`${label}: ${error.message}`)

    const page = data ?? []
    rows.push(...page)

    // A short page means the server had nothing more; a full one means keep going.
    if (page.length < pageSize) return rows

    if (rows.length >= maxRows) {
      throw new Error(
        `${label}: exceeded maxRows (${maxRows}). Refusing to return a truncated set -- ` +
          `narrow the query, or raise maxRows deliberately.`,
      )
    }
  }
}
