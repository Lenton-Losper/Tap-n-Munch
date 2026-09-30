/**
 * A small in-memory stand-in for the PostgREST client, faithful enough that the REAL route
 * handlers run against it unmodified.
 *
 * ============================================================================================
 * WHY THIS EXISTS RATHER THAN MORE MOCKS
 * ============================================================================================
 *
 * A per-test `jest.fn()` returning a canned payload proves that a handler formats what it is
 * given. It cannot prove that a bump WRITES a state that a later read SEES — which is the entire
 * question an end-to-end test of this system exists to answer, and precisely the seam the
 * 2026-09-01 Digi Cofee incident lived in.
 *
 * So this is a store, not a mock: writes land in it and subsequent reads observe them. Three
 * different real modules (buildOrderLines/writeOrderLines, the station bump route, the terminal
 * tab-lines route, issueReceiptForOrder) share one instance, exactly as they share one database.
 *
 * ============================================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================================
 *
 * It is not Postgres. No RLS, no triggers, no constraints, no advisory locks, no transactions.
 * A test that depends on any of those is lying to itself and must run against a real database
 * instead. It supports exactly the query surface the handlers under test actually use, and throws
 * loudly on anything else rather than silently returning nothing — a stub that quietly answers
 * "no rows" to a query it does not understand is how a green suite hides a broken handler.
 */

type Row = Record<string, unknown>

let uuidCounter = 0
/** Deterministic, and shaped like a UUID because routes validate the shape. */
export function testUuid(seed?: string): string {
  uuidCounter += 1
  const n = uuidCounter.toString(16).padStart(12, '0')
  const tag = (seed ?? 'test').replace(/[^0-9a-f]/gi, '0').slice(0, 4).padEnd(4, '0')
  return `${tag.padEnd(8, '0')}-${tag}-4${tag.slice(0, 3)}-8${tag.slice(0, 3)}-${n}`
}

export type TableRules = {
  /** Column defaults, as the real DDL declares them. */
  defaults?: Row
  /** Unique tuples, as the real DDL declares them. Violations return 23505, like Postgres. */
  unique?: string[][]
}

export class InMemoryDb {
  tables: Record<string, Row[]> = {}
  /** Every rpc call, so a test can assert a document number was allocated exactly once. */
  rpcCalls: Array<{ name: string; args: unknown }> = []
  private sequences: Record<string, number> = {}
  rules: Record<string, TableRules> = {}

  constructor(seed: Record<string, Row[]> = {}, rules: Record<string, TableRules> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }))
    this.rules = rules
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= [])
  }

  /** The client object handlers receive. */
  client() {
    const db = this
    return {
      from(table: string) {
        return new QueryBuilder(db, table)
      },
      async rpc(name: string, args: unknown) {
        db.rpcCalls.push({ name, args })
        if (name === 'generate_document_number') {
          const a = (args ?? {}) as { p_prefix?: string; p_sequence_name?: string }
          const key = String(a.p_sequence_name ?? 'seq')
          db.sequences[key] = (db.sequences[key] ?? 0) + 1
          return { data: `${a.p_prefix ?? 'DOC'}-${String(db.sequences[key]).padStart(6, '0')}`, error: null }
        }
        return { data: null, error: { message: `unstubbed rpc ${name}` } }
      },
    }
  }
}

type Filter = {
  kind: 'eq' | 'neq' | 'is_null' | 'not_null' | 'gt' | 'gte' | 'lt' | 'lte' | 'not_in'
  column: string
  value: unknown
}

/**
 * Postgres comparison for the range filters: numerically when both sides are numbers (order
 * numbers, cents), otherwise as text -- which is what ISO timestamps need and what they get.
 */
function compareValues(a: unknown, b: unknown): number {
  const an = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN
  const bn = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN
  if ((typeof a === 'number' || typeof b === 'number') && Number.isFinite(an) && Number.isFinite(bn)) {
    return an - bn
  }
  return String(a ?? '').localeCompare(String(b ?? ''))
}

class QueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = []
  private inFilters: Array<{ column: string; values: readonly unknown[] }> = []
  private containsFilters: Array<{ column: string; values: readonly unknown[] }> = []
  private overlapFilters: Array<{ column: string; values: readonly unknown[] }> = []
  private pending: {
    kind: 'insert' | 'update' | 'upsert' | 'delete'
    payload: Row | Row[]
    onConflict?: string
  } | null = null
  private orderBy: { column: string; ascending: boolean } | null = null
  private limitN: number | null = null
  private rangeBounds: { from: number; to: number } | null = null

  constructor(private db: InMemoryDb, private table: string) {}

  select(_cols?: string) {
    return this
  }
  eq(column: string, value: unknown) {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }
  neq(column: string, value: unknown) {
    this.filters.push({ kind: 'neq', column, value })
    return this
  }
  /**
   * PostgREST's null test — `.is('voided_at', null)`, as the tab-lines route uses to exclude voided
   * allocations.
   *
   * Only null is modelled. PostgREST also accepts true/false, and implementing those with no caller
   * to exercise them would be inventing behaviour: a fake that silently accepts a filter it does
   * not apply returns the wrong rows and looks like a passing test.
   */
  is(column: string, value: unknown) {
    if (value !== null) {
      throw new Error(`in-memory .is() models only null; received ${String(value)}`)
    }
    this.filters.push({ kind: 'is_null', column, value: null })
    return this
  }
  /**
   * Range filters (`.gt('expires_at', now)`, `.gte('placed_at', start)`). A NULL never satisfies a
   * comparison, exactly as in SQL -- a token with no expiry is not "later than now".
   */
  gt(column: string, value: unknown) {
    this.filters.push({ kind: 'gt', column, value })
    return this
  }
  gte(column: string, value: unknown) {
    this.filters.push({ kind: 'gte', column, value })
    return this
  }
  lt(column: string, value: unknown) {
    this.filters.push({ kind: 'lt', column, value })
    return this
  }
  lte(column: string, value: unknown) {
    this.filters.push({ kind: 'lte', column, value })
    return this
  }
  /**
   * PostgREST negation. Only the two shapes callers use: `.not(col, 'is', null)` (order-number
   * allocation) and `.not(col, 'in', '(a,b)')` (prepare-payment's stale-row release). Anything
   * else throws rather than being silently ignored.
   */
  not(column: string, operator: string, value: unknown) {
    if (operator === 'is' && value === null) {
      this.filters.push({ kind: 'not_null', column, value: null })
      return this
    }
    if (operator === 'in' && typeof value === 'string' && /^\(.*\)$/.test(value)) {
      const values = value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean)
      this.filters.push({ kind: 'not_in', column, value: values })
      return this
    }
    throw new Error(`in-memory .not() does not model (${column}, ${operator}, ${String(value)})`)
  }
  in(column: string, values: readonly unknown[]) {
    this.inFilters.push({ column, values })
    return this
  }
  /**
   * PostgREST's array OVERLAP (`&&`): the row's array shares AT LEAST ONE element with `values`.
   *
   * Distinct from `contains` one method down, which requires the row to hold EVERY value. The
   * payment projection uses overlap to find a tab sale covering any of several orders, where
   * `contains` would find only a sale covering all of them.
   */
  overlaps(column: string, values: readonly unknown[]) {
    this.overlapFilters.push({ column, values })
    return this
  }
  /** `.contains('order_ids', [id])` — array containment, as issueReceipt uses on payment_events. */
  contains(column: string, values: readonly unknown[]) {
    this.containsFilters.push({ column, values })
    return this
  }
  ilike(column: string, value: string) {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: opts?.ascending !== false }
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  /** PostgREST pagination. Inclusive bounds, as the real client's `.range(from, to)`. */
  range(from: number, to: number) {
    this.rangeBounds = { from, to }
    return this
  }
  insert(payload: Row | Row[]) {
    this.pending = { kind: 'insert', payload }
    return this
  }
  update(payload: Row) {
    this.pending = { kind: 'update', payload }
    return this
  }
  /** Removes exactly the rows the filters match; returns them, as `.delete().select()` does. */
  delete() {
    this.pending = { kind: 'delete', payload: {} }
    return this
  }
  /**
   * PostgREST's insert-or-update, keyed on `onConflict` as the real DDL's unique constraint.
   *
   * The conflict target is REQUIRED and is not defaulted to `id`: every caller in this app names
   * one (`{ onConflict: 'restaurant_id' }`), and silently guessing a key would let an upsert
   * insert a second row where Postgres would have updated the first -- a fake that writes a row
   * the database would not is worse than one that refuses.
   */
  upsert(payload: Row | Row[], options?: { onConflict?: string }) {
    const onConflict = options?.onConflict?.trim()
    if (!onConflict) {
      throw new Error('in-memory .upsert() requires { onConflict } naming the unique column(s)')
    }
    this.pending = { kind: 'upsert', payload, onConflict }
    return this
  }

  private matching(): Row[] {
    let out = this.db.rows(this.table)
    for (const f of this.filters) {
      out = out.filter((r) => {
        // is_null tests the ACTUAL null/undefined, not the stringified value: the eq/neq branches
        // coalesce to '' before comparing, which would make `.is('voided_at', null)` also match a
        // row whose voided_at is the empty string. For a filter that excludes voided rows from a
        // billing read, matching too much is the dangerous direction.
        if (f.kind === 'is_null') return r[f.column] == null
        if (f.kind === 'not_null') return r[f.column] != null
        if (f.kind === 'not_in') return !(f.value as string[]).includes(String(r[f.column] ?? ''))
        if (f.kind === 'gt' || f.kind === 'gte' || f.kind === 'lt' || f.kind === 'lte') {
          if (r[f.column] == null) return false
          const c = compareValues(r[f.column], f.value)
          return f.kind === 'gt' ? c > 0 : f.kind === 'gte' ? c >= 0 : f.kind === 'lt' ? c < 0 : c <= 0
        }
        return f.kind === 'eq'
          ? String(r[f.column] ?? '') === String(f.value)
          : String(r[f.column] ?? '') !== String(f.value)
      })
    }
    for (const f of this.inFilters) {
      const allowed = f.values.map(String)
      out = out.filter((r) => allowed.includes(String(r[f.column] ?? '')))
    }
    for (const f of this.overlapFilters) {
      const wanted = f.values.map(String)
      out = out.filter((r) => {
        const held = Array.isArray(r[f.column]) ? (r[f.column] as unknown[]).map(String) : []
        return held.some((v) => wanted.includes(v))
      })
    }
    for (const f of this.containsFilters) {
      out = out.filter((r) => {
        const held = Array.isArray(r[f.column]) ? (r[f.column] as unknown[]).map(String) : []
        return f.values.every((v) => held.includes(String(v)))
      })
    }
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      out = [...out].sort((a, b) => {
        // Numbers sort as numbers: order #1000 is after #999, as Postgres has it.
        const c =
          typeof a[column] === 'number' && typeof b[column] === 'number'
            ? (a[column] as number) - (b[column] as number)
            : String(a[column] ?? '').localeCompare(String(b[column] ?? ''))
        return ascending ? c : -c
      })
    }
    if (this.limitN != null) out = out.slice(0, this.limitN)
    if (this.rangeBounds) out = out.slice(this.rangeBounds.from, this.rangeBounds.to + 1)
    return out
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this.pending?.kind === 'insert') {
      const payloads = Array.isArray(this.pending.payload) ? this.pending.payload : [this.pending.payload]
      const rules = this.db.rules[this.table] ?? {}
      const created: Row[] = []
      for (const p of payloads) {
        const row: Row = {
          id: testUuid(this.table),
          created_at: new Date().toISOString(),
          ...(rules.defaults ?? {}),
          ...p,
        }
        // Postgres would reject before writing; so must this, or a test can "prove" idempotency
        // that only holds because nothing was enforcing uniqueness.
        for (const tuple of rules.unique ?? []) {
          const clash = this.db
            .rows(this.table)
            .some((existing) => tuple.every((c) => String(existing[c] ?? '') === String(row[c] ?? '')))
          if (clash) {
            return {
              data: null,
              error: {
                code: '23505',
                message: `duplicate key value violates unique constraint on (${tuple.join(', ')})`,
              },
            }
          }
        }
        this.db.rows(this.table).push(row)
        created.push(row)
      }
      return { data: created, error: null }
    }
    if (this.pending?.kind === 'update') {
      const hit = this.matching()
      for (const r of hit) Object.assign(r, this.pending.payload)
      return { data: hit, error: null }
    }
    if (this.pending?.kind === 'delete') {
      const hit = this.matching()
      const all = this.db.rows(this.table)
      for (const r of hit) all.splice(all.indexOf(r), 1)
      return { data: hit, error: null }
    }
    if (this.pending?.kind === 'upsert') {
      const keys = (this.pending.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean)
      const payloads = Array.isArray(this.pending.payload)
        ? this.pending.payload
        : [this.pending.payload]
      const rules = this.db.rules[this.table] ?? {}
      const written: Row[] = []
      for (const p of payloads) {
        const existing = this.db
          .rows(this.table)
          .find((r) => keys.every((k) => String(r[k] ?? '') === String(p[k] ?? '')))
        if (existing) {
          Object.assign(existing, p)
          written.push(existing)
          continue
        }
        const row: Row = {
          id: testUuid(this.table),
          created_at: new Date().toISOString(),
          ...(rules.defaults ?? {}),
          ...p,
        }
        this.db.rows(this.table).push(row)
        written.push(row)
      }
      return { data: written, error: null }
    }
    return { data: this.matching(), error: null }
  }

  async maybeSingle() {
    const r = this.resolve()
    const arr = (r.data ?? []) as Row[]
    return { data: arr[0] ?? null, error: r.error }
  }

  async single() {
    const r = this.resolve()
    // A failed write reports ITS error (a 23505 from a unique rule), not "no rows": the real client
    // does, and createOrder's idempotent-replay branch keys off exactly that code.
    if (r.error) return { data: null, error: r.error }
    const arr = (r.data ?? []) as Row[]
    if (!arr[0]) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
    }
    return { data: arr[0], error: r.error }
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onFulfilled?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((r: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return Promise.resolve(this.resolve()).then(onFulfilled, onRejected)
    } catch (err) {
      return Promise.reject(err) as PromiseLike<TResult2>
    }
  }
}
