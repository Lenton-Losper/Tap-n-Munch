/**
 * RIVIERA #160 AS THE REAL DATABASE WROTE IT, REPLAYED UNDER THE REAL ROUTES.
 *
 * `supabase/tests/riviera-modena-chain.test.sql` runs the incident through the real
 * `amend_order_lines` and `settle_order_payment` in Postgres and records every row they wrote,
 * after every step, in `__tests__/fixtures/riviera-modena-rpc-snapshot.json`. The DB runner fails
 * when those functions stop producing exactly that file, so it cannot drift.
 *
 * This module lets a jest test put the real amend route (and everything that reads after it) on
 * top of those rows. When the route calls `rpc('amend_order_lines', args)`:
 *
 *   1. the args must be EXACTLY what the SQL test called the function with -- order number,
 *      actor, amendments -- or the call is answered with an error (the route turns that into a
 *      502, which the test sees);
 *   2. the rows the route is about to amend must be EXACTLY the rows the function amended
 *      (orders + order_lines, snapshot columns) -- so the jest world and the SQL world are the same
 *      world at every step, not two fixtures that happen to agree on a total;
 *   3. the function's own answer is returned, and the rows it wrote are applied to the store.
 *
 * It is not a model of the RPC. Nothing here decides what a void does -- Postgres already did.
 */
import { InMemoryDb } from './in-memory-postgrest'

type Row = Record<string, unknown>

export type ModenaState = {
  tabs: Row[]
  orders: Row[]
  order_lines: Row[]
  order_line_events: Row[]
  payment_events: Row[]
  payment_tips: Row[]
}

export type ModenaStep = {
  name: string
  kind: 'amend_order_lines' | 'prepare_payment' | 'settle_order_payment' | 'station'
  call?: Record<string, unknown>
  result?: Record<string, unknown>
  line_id?: string
  station?: string
  to_state?: string
  post: ModenaState
}

export type ModenaSnapshot = {
  seed: ModenaState
  reductions: ModenaStep[]
  branch_a: ModenaStep[]
  branch_b: ModenaStep[]
  /** Riviera #154 + #155 settled as ONE card payment of N$720 by settle_order_payment. */
  riviera_720: { result: Record<string, unknown>; post: ModenaState }
  /** The same, with a N$30 gratuity riding on the charge (N$750 to the gateway). */
  riviera_720_tip: { result: Record<string, unknown>; post: ModenaState }
}

export const SNAP: ModenaSnapshot = require('../fixtures/riviera-modena-rpc-snapshot.json')

export const R = '11111111-1111-4111-8111-111111111111'
export const TAB = '22222222-2222-4222-8222-222222222222'
export const MANAGER = '55555555-5555-4555-8555-555555555555'
export const TERMINAL = 'c103a8bd-759a-4a61-bc79-5043adae50c7'
export const O160 = 'eeeeeeee-0000-4000-8000-000000000160'
export const VAT = 'abab0001-0000-4000-8000-000000000015'
/** Line ids by source_item_index on #160, as seeded. */
export const LINE = {
  modena: 'eeeeeeee-0000-4000-8000-0000000001a0',
  wywh: 'eeeeeeee-0000-4000-8000-0000000001a1',
  salmon: 'eeeeeeee-0000-4000-8000-0000000001a2',
  burger: 'eeeeeeee-0000-4000-8000-0000000001a3',
} as const

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Key-order-independent JSON: jsonb sorts keys by length, a route builds them in its own order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Columns the SQL rows do not carry, as the real tables default them. */
function orderDefaults(order: Row): Row {
  // Minutes past 18:00 by order number, so placement order is number order (#154 < #160 < #164).
  const at = `2026-09-24T18:${String(Number(order.order_number) % 60).padStart(2, '0')}:00.000Z`
  return {
    placed_at: at,
    created_at: at,
    terminal_pushed_at: null,
    paid_at: null,
    completed_at: null,
    payment_voucher_no: null,
    member_session_id: null,
    session_id: null,
    tab_settlement_for_tab_id: null,
    requires_reacceptance: false,
    order_instructions: null,
    idempotency_key: null,
  }
}

function mergeRows(db: InMemoryDb, table: string, rows: Row[], defaults: (r: Row) => Row, keepExisting = false) {
  for (const incoming of rows) {
    const existing = db.rows(table).find((r) => String(r.id) === String(incoming.id))
    if (existing) {
      if (!keepExisting) Object.assign(existing, clone(incoming))
    } else {
      db.rows(table).push({ ...defaults(incoming), ...clone(incoming) })
    }
  }
}

/** Apply what the database wrote. Events already present are kept (the route may have annotated them). */
export function applyState(db: InMemoryDb, state: ModenaState): void {
  mergeRows(db, 'tabs', state.tabs, () => ({}))
  mergeRows(db, 'orders', state.orders, orderDefaults)
  let seq = db.rows('order_lines').length
  mergeRows(db, 'order_lines', state.order_lines, () => {
    seq += 1
    return { created_at: `2026-09-24T18:00:${String(seq).padStart(2, '0')}.000Z` }
  })
  mergeRows(db, 'order_line_events', state.order_line_events, () => ({ occurred_at: '2026-09-24T18:30:00.000Z' }), true)
  for (const tip of state.payment_tips ?? []) {
    const exists = db
      .rows('payment_tips')
      .some((t) => t.payment_reference === tip.payment_reference && t.tip_cents === tip.tip_cents)
    if (!exists) db.rows('payment_tips').push({ id: `tip-${String(tip.payment_reference)}`, ...clone(tip) })
  }
  mergeRows(
    db,
    'payment_events',
    state.payment_events,
    () => ({ created_at: '2026-09-24T21:00:00.000Z', idempotency_key: 'MO-MODENA-1' }),
  )
}

/** The seed state plus the rows the routes need that the SQL fixture has no reason to carry. */
export function seedModenaDb(extra: Record<string, Row[]> = {}): InMemoryDb {
  const db = new InMemoryDb({
    restaurants: [{ id: R, name: 'Riviera', phone: '+264 61 000000', address: '1 Sam Nujoma Ave', logo_url: null, timezone: 'Africa/Windhoek' }],
    restaurant_tables: [{ id: 'aaaa0001-0000-4000-8000-000000000001', restaurant_id: R, table_number: 1, status: 'occupied', active: true }],
    tabs: [],
    orders: [],
    order_lines: [],
    order_line_events: [],
    payment_events: [],
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    order_requests: [],
    privileged_authorization_tokens: [],
    authorization_events: [],
    tax_rates: [{ id: VAT, restaurant_id: R, name: 'VAT', percentage: 15, is_inclusive: true, is_default: true }],
    restaurant_billing_profiles: [
      {
        restaurant_id: R,
        registration_number: 'CC/2019/04471',
        vat_number: '8123456-01-5',
        bank_name: 'Bank Windhoek',
        bank_account_name: 'Riviera Trading CC',
        bank_account_number: '8009112233',
        bank_branch_code: '481972',
      },
    ],
    business_documents: [],
    document_payments: [],
    payments: [],
    payment_tips: [],
    audit_logs: [],
    restaurant_users: [{ restaurant_id: R, user_id: MANAGER, deleted_at: null }],
    ...extra,
  }, {
    // As the DDL declares them (20260705280000, 20260722140000): an invoice starts as a draft.
    business_documents: {
      defaults: { issued_at: '2026-09-28T08:00:00.000Z', currency: 'NAD', status: 'draft', sent_at: null },
    },
  })
  applyState(db, SNAP.seed)
  const tab = db.rows('tabs')[0]
  Object.assign(tab, {
    table_id: 'aaaa0001-0000-4000-8000-000000000001',
    created_at: '2026-09-24T17:55:00.000Z',
    opened_by_user_id: null,
    settled_at: null,
    members: [],
    payment_preference: null,
    ready_to_pay_at: null,
  })
  return db
}

/** A single-use manager PIN token for this terminal, as authorize-terminal-action mints it. */
export function mintToken(db: InMemoryDb, id: string, purpose = 'line_void'): string {
  db.rows('privileged_authorization_tokens').push({
    id,
    user_id: MANAGER,
    restaurant_id: R,
    terminal_id: TERMINAL,
    purpose,
    used_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
  })
  return id
}

const ORDER_COMPARE = ['id', 'order_number', 'status', 'payment_status', 'total', 'items', 'tab_id', 'restaurant_id']
const LINE_COMPARE = ['id', 'order_id', 'source_item_index', 'name_snapshot', 'quantity', 'route_to', 'kitchen_state', 'bar_state']

function project(rows: Row[], cols: string[], sortKey: (r: Row) => string): Row[] {
  return rows
    .map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}

/**
 * The store's orders and lines on the tab, in the snapshot's columns -- compared with what the
 * database held before it answered. A difference is returned as text, for the failure message.
 */
export function diffAgainst(db: InMemoryDb, state: ModenaState): string | null {
  const byOrder = (r: Row) => String(r.order_number).padStart(6, '0')
  const byLine = (r: Row) => `${r.order_id}:${String(r.source_item_index).padStart(3, '0')}`
  const mineOrders = project(db.rows('orders').filter((o) => o.tab_id === TAB), ORDER_COMPARE, byOrder)
  const theirOrders = project(state.orders, ORDER_COMPARE, byOrder)
  const mineLines = project(db.rows('order_lines').filter((l) => l.tab_id === TAB), LINE_COMPARE, byLine)
  const theirLines = project(state.order_lines, LINE_COMPARE, byLine)
  const a = canonical({ orders: mineOrders, lines: mineLines })
  const b = canonical({ orders: theirOrders, lines: theirLines })
  return a === b ? null : `store:\n${a}\n\ndatabase:\n${b}`
}

/**
 * An rpc() that answers `amend_order_lines` from the recorded steps, in order, and anything else
 * from `fallback`. Every disagreement is pushed to `problems` AND answered with an error, so a test
 * sees it twice: as a non-200 from the route, and in the list it asserts empty.
 */
export function replayingRpc(
  db: InMemoryDb,
  steps: ModenaStep[],
  problems: string[],
  fallback: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>,
) {
  const queue = [...steps]
  let previous: ModenaState = SNAP.seed
  return {
    /** Steps that are not route calls (a station bump, a settlement) move the cursor explicitly. */
    advanceTo(step: ModenaStep) {
      const i = queue.indexOf(step)
      if (i >= 0) queue.splice(0, i + 1)
      previous = step.post
    },
    remaining: () => queue.length,
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'amend_order_lines') return fallback(name, args)
      const step = queue.shift()
      if (!step || step.kind !== 'amend_order_lines') {
        problems.push(`unexpected amend_order_lines call ${JSON.stringify(args)}`)
        return { data: null, error: { message: 'no recorded step for this call' } }
      }
      if (canonical(args) !== canonical(step.call)) {
        problems.push(`${step.name}: called with ${JSON.stringify(args)}, database was called with ${JSON.stringify(step.call)}`)
        return { data: null, error: { message: 'call differs from the recorded call' } }
      }
      const diff = diffAgainst(db, previous)
      if (diff) {
        problems.push(`${step.name}: the rows differ from the rows the database amended\n${diff}`)
        return { data: null, error: { message: 'pre-state differs' } }
      }
      applyState(db, step.post)
      previous = step.post
      return { data: clone(step.result), error: null }
    },
  }
}
