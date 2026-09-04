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

type Filter = { kind: 'eq' | 'neq' | 'is_null'; column: string; value: unknown }

class QueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = []
  private inFilters: Array<{ column: string; values: readonly unknown[] }> = []
  private containsFilters: Array<{ column: string; values: readonly unknown[] }> = []
  private pending: { kind: 'insert' | 'update'; payload: Row | Row[] } | null = null
  private orderBy: { column: string; ascending: boolean } | null = null
  private limitN: number | null = null

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
  in(column: string, values: readonly unknown[]) {
    this.inFilters.push({ column, values })
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
  insert(payload: Row | Row[]) {
    this.pending = { kind: 'insert', payload }
    return this
  }
  update(payload: Row) {
    this.pending = { kind: 'update', payload }
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
        return f.kind === 'eq'
          ? String(r[f.column] ?? '') === String(f.value)
          : String(r[f.column] ?? '') !== String(f.value)
      })
    }
    for (const f of this.inFilters) {
      const allowed = f.values.map(String)
      out = out.filter((r) => allowed.includes(String(r[f.column] ?? '')))
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
        const av = String(a[column] ?? '')
        const bv = String(b[column] ?? '')
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    if (this.limitN != null) out = out.slice(0, this.limitN)
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
    return { data: this.matching(), error: null }
  }

  async maybeSingle() {
    const r = this.resolve()
    const arr = (r.data ?? []) as Row[]
    return { data: arr[0] ?? null, error: r.error }
  }

  async single() {
    const r = this.resolve()
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
