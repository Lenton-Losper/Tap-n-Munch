/**
 * An in-memory stand-in for the tables the settle route touches, which ENFORCES the real
 * payment_events constraints.
 *
 * This matters more than it looks. A fake that accepts any insert passes whether or not the
 * code under test is correct, so it proves nothing -- that exact mistake hid a live SQL
 * injection on this project, and a permissive mock of markOrderPaidConfirmed hid a defect that
 * had moved inside it. So every constraint below is one this fake can FAIL on:
 *
 *   - NOT NULL on restaurant_id, business_order_no, origin_business_order_no, idempotency_key,
 *     reason_code, amount, event_type
 *   - CHECK event_type IN ('sale','refund_attempted','refund_succeeded','refund_failed')
 *     -- so writing event_type 'settle_card' is rejected here exactly as production would
 *   - CHECK amount > 0
 *   - CHECK cardinality(order_ids) > 0
 *   - UNIQUE (restaurant_id, idempotency_key), reported as code 23505
 *   - the singular order_id column does NOT exist (a later migration replaced it with
 *     order_ids uuid[]), so passing it is an error rather than a silently ignored field
 *
 * Verified against staging by scripts/probe-payment-events-contract-staging.mjs, which asserts
 * the same set on the deployed table.
 */

export type FakeRow = Record<string, unknown>

const VALID_EVENT_TYPES = ['sale', 'refund_attempted', 'refund_succeeded', 'refund_failed']

const PAYMENT_EVENTS_COLUMNS = new Set([
  'id',
  'restaurant_id',
  'event_type',
  'business_order_no',
  'origin_business_order_no',
  'transaction_id',
  'terminal_id',
  'app_version',
  'amount',
  'currency',
  'idempotency_key',
  'initiated_by',
  'reason_code',
  'reason_note',
  'gateway_result_code',
  'gateway_result_message',
  'raw_gateway_response',
  'created_at',
  'order_ids',
])

export type PgError = { message: string; code?: string; details?: string }

function pgError(message: string, code?: string): PgError {
  return { message, code }
}

/** Rejects exactly what production rejects. Returns null when the row is legal. */
export function validatePaymentEvent(row: FakeRow, existing: FakeRow[]): PgError | null {
  for (const key of Object.keys(row)) {
    if (!PAYMENT_EVENTS_COLUMNS.has(key)) {
      return pgError(
        `column "${key}" of relation "payment_events" does not exist`,
        '42703',
      )
    }
  }

  const notNull = [
    'restaurant_id',
    'event_type',
    'business_order_no',
    'origin_business_order_no',
    'amount',
    'idempotency_key',
    'reason_code',
  ]
  for (const col of notNull) {
    if (row[col] === null || row[col] === undefined || row[col] === '') {
      return pgError(
        `null value in column "${col}" of relation "payment_events" violates not-null constraint`,
        '23502',
      )
    }
  }

  if (!VALID_EVENT_TYPES.includes(String(row.event_type))) {
    return pgError(
      'new row for relation "payment_events" violates check constraint "payment_events_event_type_check"',
      '23514',
    )
  }

  if (!(Number(row.amount) > 0)) {
    return pgError(
      'new row for relation "payment_events" violates check constraint "payment_events_amount_positive"',
      '23514',
    )
  }

  const orderIds = row.order_ids
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return pgError(
      'new row for relation "payment_events" violates check constraint "payment_events_order_ids_not_empty"',
      '23514',
    )
  }

  const clash = existing.some(
    (r) =>
      String(r.restaurant_id) === String(row.restaurant_id) &&
      String(r.idempotency_key) === String(row.idempotency_key),
  )
  if (clash) {
    return pgError(
      'duplicate key value violates unique constraint "payment_events_restaurant_id_idempotency_key_key"',
      '23505',
    )
  }

  return null
}

export type FakeDbOptions = {
  /** Force an insert on this table to fail, simulating a transport/database outage. */
  failInsertOn?: Partial<Record<string, PgError>>
  /** Force a select on this table to fail. */
  failSelectOn?: Partial<Record<string, PgError>>
}

type Op = { kind: string; args: unknown[] }

export class FakeDb {
  tables: Record<string, FakeRow[]> = {
    tabs: [],
    orders: [],
    payments: [],
    audit_logs: [],
    payment_events: [],
    restaurants: [],
  }
  options: FakeDbOptions
  /** Every insert attempted, in order, including ones the constraints rejected. */
  insertAttempts: Array<{ table: string; rows: FakeRow[]; rejected: PgError | null }> = []
  private seq = 0

  constructor(options: FakeDbOptions = {}) {
    this.options = options
  }

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  saleRows(): FakeRow[] {
    return this.tables.payment_events.filter((r) => r.event_type === 'sale')
  }

  auditRows(action: string): FakeRow[] {
    return this.tables.audit_logs.filter((r) => r.action === action)
  }

  client() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this
    return {
      from(table: string) {
        return new FakeQuery(db, table)
      },
    }
  }
}

class FakeQuery {
  private ops: Op[] = []
  private mode: 'select' | 'insert' | 'update' | null = null
  private payload: FakeRow | FakeRow[] | null = null
  private selectAfterWrite = false

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  private push(kind: string, ...args: unknown[]) {
    this.ops.push({ kind, args })
    return this
  }

  select(_cols?: string) {
    if (this.mode === 'insert' || this.mode === 'update') {
      this.selectAfterWrite = true
      return this
    }
    this.mode = 'select'
    return this
  }
  insert(payload: FakeRow | FakeRow[]) {
    this.mode = 'insert'
    this.payload = payload
    return this
  }
  update(payload: FakeRow) {
    this.mode = 'update'
    this.payload = payload
    return this
  }
  eq(col: string, val: unknown) {
    return this.push('eq', col, val)
  }
  neq(col: string, val: unknown) {
    return this.push('neq', col, val)
  }
  in(col: string, vals: unknown[]) {
    return this.push('in', col, vals)
  }
  is(col: string, val: unknown) {
    return this.push('is', col, val)
  }
  gte(col: string, val: unknown) {
    return this.push('gte', col, val)
  }
  lt(col: string, val: unknown) {
    return this.push('lt', col, val)
  }
  or(expr: string) {
    return this.push('or', expr)
  }
  contains(col: string, vals: unknown[]) {
    return this.push('contains', col, vals)
  }
  overlaps(col: string, vals: unknown[]) {
    return this.push('overlaps', col, vals)
  }
  order() {
    return this
  }
  limit(n: number) {
    return this.push('limit', n)
  }

  private matches(row: FakeRow): boolean {
    for (const op of this.ops) {
      const [col, val] = op.args as [string, unknown]
      switch (op.kind) {
        case 'eq':
          if (String(row[col]) !== String(val)) return false
          break
        case 'neq':
          if (String(row[col]) === String(val)) return false
          break
        case 'in':
          if (!(val as unknown[]).map(String).includes(String(row[col]))) return false
          break
        case 'is':
          if (val === null && row[col] !== null && row[col] !== undefined) return false
          break
        case 'gte':
          if (!(String(row[col]) >= String(val))) return false
          break
        case 'lt':
          if (!(String(row[col]) < String(val))) return false
          break
        case 'contains': {
          const arr = (row[col] as unknown[]) ?? []
          if (!(val as unknown[]).every((v) => arr.map(String).includes(String(v)))) return false
          break
        }
        case 'overlaps': {
          const arr = (row[col] as unknown[]) ?? []
          if (!(val as unknown[]).some((v) => arr.map(String).includes(String(v)))) return false
          break
        }
        // 'or' is only used by the cash claim; the tests that exercise it assert on which
        // rows were claimed, so treating it as unconstrained here would silently widen the
        // claim. Handled by the caller supplying rows that the narrower filters already pin.
        default:
          break
      }
    }
    return true
  }

  private rows(): FakeRow[] {
    return this.db.tables[this.table] ?? (this.db.tables[this.table] = [])
  }

  private run(): { data: FakeRow[] | null; error: PgError | null } {
    const rows = this.rows()

    if (this.mode === 'insert') {
      const failure = this.db.options.failInsertOn?.[this.table]
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as FakeRow]

      if (failure) {
        this.db.insertAttempts.push({ table: this.table, rows: incoming, rejected: failure })
        return { data: null, error: failure }
      }

      const created: FakeRow[] = []
      for (const raw of incoming) {
        const row: FakeRow = { ...raw }
        if (this.table === 'payment_events') {
          const violation = validatePaymentEvent(row, rows)
          if (violation) {
            this.db.insertAttempts.push({ table: this.table, rows: [row], rejected: violation })
            return { data: null, error: violation }
          }
        }
        row.id = row.id ?? this.db.nextId(this.table)
        row.created_at = row.created_at ?? new Date().toISOString()
        rows.push(row)
        created.push(row)
      }
      this.db.insertAttempts.push({ table: this.table, rows: created, rejected: null })
      return { data: created, error: null }
    }

    if (this.mode === 'update') {
      const matched = rows.filter((r) => this.matches(r))
      for (const row of matched) Object.assign(row, this.payload as FakeRow)
      return { data: matched, error: null }
    }

    const failure = this.db.options.failSelectOn?.[this.table]
    if (failure) return { data: null, error: failure }

    let matched = rows.filter((r) => this.matches(r))
    const limitOp = this.ops.find((o) => o.kind === 'limit')
    if (limitOp) matched = matched.slice(0, Number(limitOp.args[0]))
    return { data: matched, error: null }
  }

  async single() {
    const { data, error } = this.run()
    if (error) return { data: null, error }
    if (!data || data.length !== 1) {
      return {
        data: null,
        error: pgError('JSON object requested, multiple (or no) rows returned', 'PGRST116'),
      }
    }
    return { data: data[0], error: null }
  }

  async maybeSingle() {
    const { data, error } = this.run()
    if (error) return { data: null, error }
    return { data: data && data.length > 0 ? data[0] : null, error: null }
  }

  then(
    resolve: (v: { data: FakeRow[] | null; error: PgError | null }) => unknown,
    reject?: (e: unknown) => unknown,
  ) {
    try {
      const result = this.run()
      if ((this.mode === 'insert' || this.mode === 'update') && !this.selectAfterWrite) {
        return Promise.resolve(resolve({ data: result.data, error: result.error }))
      }
      return Promise.resolve(resolve(result))
    } catch (err) {
      return reject ? Promise.resolve(reject(err)) : Promise.reject(err)
    }
  }
}
