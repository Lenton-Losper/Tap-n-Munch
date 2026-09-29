/**
 * Shared harness for the reconciliation suites (Sprint 2026-09-29, tasks 4 and 7):
 *   __tests__/staff-reconcile-reference.test.ts
 *   __tests__/reconcile-orphan-payments-gateway-verified.test.ts
 *
 * NOT A TEST FILE (no `.test.ts`).
 *
 * The REAL route / cron, the REAL reference binder, the REAL settlement-target resolver, the REAL
 * financial projection and the REAL settleWholeOrderPayment all run against one InMemoryDb.
 *
 * `settle_order_payment` is SIMULATED here, not executed: what the plpgsql function does is proved
 * against a real Postgres by supabase/tests/run-db-tests.mjs. The simulation models only what these
 * suites need to observe -- the claim, the ledger row (ON CONFLICT DO NOTHING on the idempotency
 * key), intent consumption, and the refusals the callers map -- so that a SECOND reconciliation sees
 * the first one's writes, which is what the duplicate tests are about.
 */
import { InMemoryDb } from './in-memory-postgrest'

type Row = Record<string, unknown>

export const VENUE = '11111111-1111-4111-8111-111111111111'
export const OTHER_VENUE = '99999999-9999-4999-8999-999999999999'
export const STAFF = '55555555-5555-4555-8555-555555555555'

const OWING = [
  'unpaid', 'pending', 'terminal_pending', 'cash_pending', 'failed',
  'amount_mismatch_hold', 'verification_unavailable_hold',
]

export function order(id: string, over: Row = {}): Row {
  return {
    id,
    restaurant_id: VENUE,
    tab_id: null,
    order_number: 1,
    status: 'pending',
    payment_status: 'pending',
    payment_method: null,
    payment_reference: null,
    paycloud_merchant_order_no: null,
    paycloud_transaction_id: null,
    total: 100,
    items: [{ name: 'Burger', quantity: 1, unitPrice: 100, total: 100 }],
    pending_charge_cents: null,
    pending_tip_cents: 0,
    pending_settlement_id: null,
    settled_charge_cents: null,
    cancellation_reason: null,
    cancelled_at: null,
    tab_settlement_for_tab_id: null,
    paid_at: null,
    ...over,
  }
}

export function intent(over: Row = {}): Row {
  return {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    merchant_order_no: 'FT-INTENT-1',
    amount_cents: 10000,
    scope: 'orders',
    order_ids: [],
    allocation_ids: [],
    status: 'launched',
    restaurant_id: VENUE,
    tab_id: null,
    tip_cents: 0,
    tip_staff_user_id: null,
    consumed_at: null,
    settled_order_ids: null,
    ...over,
  }
}

export function makeDb(seed: Record<string, Row[]> = {}) {
  const db = new InMemoryDb(
    {
      orders: [],
      order_lines: [],
      order_line_allocations: [],
      order_line_allocation_settlements: [],
      terminal_payment_intents: [],
      payment_events: [],
      audit_logs: [],
      receipt_documents: [],
      ...seed,
    },
    {
      payment_events: { unique: [['restaurant_id', 'idempotency_key']] },
    },
  )
  const base = db.client()
  const client = {
    ...base,
    from: base.from,
    rpc: async (name: string, args: Row) => {
      db.rpcCalls.push({ name, args })
      if (name !== 'settle_order_payment') return base.rpc(name, args)
      return { data: simulateSettle(db, args), error: null }
    },
  }
  return { db, client }
}

function simulateSettle(db: InMemoryDb, a: Row): Row {
  const ids = (a.p_order_ids as string[]).map(String)
  const restaurant = String(a.p_restaurant_id)
  const gateway = a.p_gateway_amount_cents as number | null
  const ref = String(a.p_merchant_order_no || a.p_payment_reference || '')
  const allow = ((a.p_allow_cancelled_recovery as string[]) ?? []).map(String)
  if (gateway == null) return { ok: false, reason: 'gateway_amount_absent', claimed_order_ids: [] }

  let intentRow: Row | undefined
  if (a.p_intent_id) {
    intentRow = db.rows('terminal_payment_intents').find((r) => r.id === a.p_intent_id)
    if (!intentRow) throw new Error('intent not found')
    if (intentRow.restaurant_id !== restaurant) throw new Error('intent belongs to another restaurant')
    if (intentRow.consumed_at) {
      return { ok: true, reason: 'already_consumed', applied: false, claimed_order_ids: intentRow.settled_order_ids ?? [] }
    }
    if (Number(intentRow.amount_cents) !== gateway) {
      return { ok: false, reason: 'intent_amount_mismatch', claimed_order_ids: [] }
    }
  }

  const rows = db.rows('orders').filter((r) => ids.includes(String(r.id)) && r.restaurant_id === restaurant)
  if (rows.length !== ids.length) return { ok: false, reason: 'orders_missing', claimed_order_ids: [] }
  const cents = (r: Row) =>
    Number(r.pending_charge_cents) > 0 ? Number(r.pending_charge_cents) : Math.round(Number(r.total) * 100)
  const recomputed = rows.reduce((s, r) => s + cents(r), 0)
  if (a.p_expected_amount_cents != null && recomputed !== a.p_expected_amount_cents) {
    return { ok: false, reason: 'target_changed_since_preparation', claimed_order_ids: [] }
  }
  if (recomputed !== gateway) return { ok: false, reason: 'amount_mismatch', claimed_order_ids: [] }
  for (const r of rows) {
    const st = String(r.payment_status)
    if (st === 'paid') continue
    if (st === 'cancelled' && !allow.includes(String(r.id))) {
      return { ok: false, reason: 'illegal_transition', claimed_order_ids: [] }
    }
    if (!OWING.includes(st) && st !== 'cancelled') {
      return { ok: false, reason: 'illegal_transition', claimed_order_ids: [] }
    }
  }

  const claimed: string[] = []
  const now = new Date().toISOString()
  for (const r of rows) {
    if (r.payment_status === 'paid') continue
    const recorded = Number(r.pending_charge_cents) > 0 ? Number(r.pending_charge_cents) - Number(r.pending_tip_cents ?? 0) : null
    Object.assign(r, {
      payment_status: 'paid',
      status: 'completed',
      payment_method: a.p_payment_method,
      payment_reference: a.p_payment_reference,
      paycloud_transaction_id: a.p_gateway_transaction_id ?? r.paycloud_transaction_id,
      paid_at: now,
      cancelled_at: null,
      cancellation_reason: null,
      pending_charge_cents: null,
      settled_charge_cents: recorded,
      paycloud_merchant_order_no: r.paycloud_merchant_order_no ?? (String(r.id) === ids[0] ? ref : null),
    })
    claimed.push(String(r.id))
  }

  let ledger = false
  if (claimed.length) {
    const events = db.rows('payment_events')
    // 20260929130000: a device report for this charge is PROMOTED in place, never joined.
    const device = events.find(
      (e) =>
        e.restaurant_id === restaurant &&
        e.event_type === 'sale' &&
        e.origin === 'terminal_device' &&
        (e.idempotency_key === ref ||
          (a.p_gateway_transaction_id != null && e.transaction_id === a.p_gateway_transaction_id)),
    )
    if (device) {
      const raw = (device.raw_gateway_response as Row | null) ?? {}
      Object.assign(device, {
        origin: 'gateway',
        amount: gateway / 100,
        order_ids: ids,
        raw_gateway_response: { ...raw, promoted: { recorded_by: 'server', device_reported_amount: device.amount } },
      })
      db.rows('audit_logs').push({
        id: `audit-promote-${db.rows('audit_logs').length}`,
        restaurant_id: restaurant,
        action: 'payment.device_row_promoted',
        entity_type: 'payment_event',
        entity_id: String(device.id),
        metadata: { device_reported_amount: device.amount, gateway_amount_cents: gateway },
      })
    } else if (!events.some((e) => e.restaurant_id === restaurant && e.idempotency_key === ref)) {
      events.push({
        id: `ledger-${events.length + 1}`,
        restaurant_id: restaurant,
        order_ids: ids,
        event_type: 'sale',
        business_order_no: ref,
        origin_business_order_no: ref,
        transaction_id: a.p_gateway_transaction_id,
        amount: gateway / 100,
        idempotency_key: ref,
        reason_code: 'sale',
        origin: null,
        raw_gateway_response: { recorded_by: 'server', source: a.p_source },
        created_at: now,
      })
      ledger = true
    }
  }
  db.rows('audit_logs').push({
    id: `audit-settle-${db.rows('audit_logs').length}`,
    restaurant_id: restaurant,
    action: 'payment.settlement_applied',
    entity_type: 'payment_settlement',
    entity_id: String(a.p_intent_id ?? ref),
    metadata: { source: a.p_source, applied_order_ids: claimed, ledger_row_written: ledger },
  })
  if (intentRow) {
    Object.assign(intentRow, { status: 'confirmed', consumed_at: now, settled_order_ids: ids })
  }
  return {
    ok: true,
    reason: 'settled',
    applied: true,
    claimed_order_ids: claimed,
    intended_order_ids: ids,
    expected_amount_cents: recomputed,
    ledger_row_written: ledger,
  }
}

/** A Finatic order.query answer as `queryPaymentOrder` returns it. */
export function finaticPaid(amount: number | null, transactionId = 'TXN-1') {
  const data: Row = { trans_status: 2 }
  if (amount !== null) data.paid_amount = amount
  return { rawResponse: { data: JSON.stringify(data), psn: transactionId } }
}

export function finaticNotPaid() {
  return { rawResponse: { data: JSON.stringify({ trans_status: 1, paid_amount: '0' }) } }
}

export function e04111Error() {
  return Object.assign(new Error('PayCloud business error E04111'), { responseBody: { code: 'E04111' } })
}

export const audits = (db: InMemoryDb, action: string) =>
  db.rows('audit_logs').filter((r) => r.action === action)

export const paidIds = (db: InMemoryDb) =>
  db.rows('orders').filter((r) => r.payment_status === 'paid').map((r) => String(r.id)).sort()

export const settleCalls = (db: InMemoryDb) => db.rpcCalls.filter((c) => c.name === 'settle_order_payment')
