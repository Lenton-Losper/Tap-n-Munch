/**
 * Sprint 2026-09-29 brief, TASK 4 — STAFF RECONCILIATION REFERENCE.
 *
 * POST /api/payments/reconcile took client-chosen orderIds + merchantOrderNo, asked Finatic about
 * the reference and, if the amount equalled the orders' summed totals, marked them paid with an
 * unconditional UPDATE (status 'accepted', cancelled -> paid allowed), no check that the reference
 * belonged to those orders or that venue, no consumed-reference check, no ledger or audit row.
 *
 * These run the REAL route, reference binder, target resolver, projection and
 * settleWholeOrderPayment against one in-memory store (__tests__/helpers/reconcile-harness.ts).
 * Every guard here has a mutation in scripts/mutate-reconcile.mjs that must turn this suite RED.
 */
import {
  OTHER_VENUE,
  STAFF,
  VENUE,
  audits,
  e04111Error,
  finaticNotPaid,
  finaticPaid,
  intent,
  makeDb,
  order,
  paidIds,
  settleCalls,
} from './helpers/reconcile-harness'

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'aaaaaaaa-0000-4000-8000-00000000000b'
const C = 'aaaaaaaa-0000-4000-8000-00000000000c'
const X = 'aaaaaaaa-0000-4000-8000-0000000000ff'
const REF = 'FT-REF-1'

const mockQuery = jest.fn()
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: (...args: unknown[]) => mockQuery(...args),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'M1', storeNo: 'S1', terminalSn: null }),
  isMissingFinaticCredentialsError: () => false,
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => id,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
  safeIssueReceiptForOrder: async () => undefined,
}))

let mockHarness: ReturnType<typeof makeDb>
let mockAuthDenied = false
jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (r: unknown) => r instanceof Response,
  requireCallerRestaurantPermission: async () =>
    mockAuthDenied
      ? new Response(JSON.stringify({ error: 'Authentication required.' }), { status: 401 })
      : { userId: STAFF, restaurantId: VENUE, supabase: mockHarness.client },
}))

type Row = Record<string, unknown>

/** A (N$100) + B (N$50), prepared together: REF on the lead, one pending_settlement_id. */
function seedPair(extra: Record<string, Row[]> = {}, over: { a?: Row; b?: Row } = {}) {
  mockHarness = makeDb({
    orders: [
      order(A, {
        paycloud_merchant_order_no: REF,
        pending_settlement_id: 'dddddddd-0000-4000-8000-000000000001',
        pending_charge_cents: 10000,
        ...over.a,
      }),
      order(B, {
        total: 50,
        items: [{ name: 'Chips', quantity: 1, unitPrice: 50, total: 50 }],
        pending_settlement_id: 'dddddddd-0000-4000-8000-000000000001',
        pending_charge_cents: 5000,
        ...over.b,
      }),
      ...(extra.orders ?? []),
    ],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'orders')),
  })
  return mockHarness.db
}

async function call(body: Row) {
  const { POST } = await import('@/app/api/payments/reconcile/route')
  const res = await POST(
    new Request('https://staging.test/api/payments/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ restaurantId: VENUE, ...body }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Row }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockAuthDenied = false
})

describe('valid reference', () => {
  it('settles exactly the prepared set through the RPC: ledger row, audit rows, completed not accepted', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(150, 'TXN-OK'))

    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })

    expect({ status: r.status, applied: r.body.applied }).toEqual({ status: 200, applied: true })
    expect(paidIds(db)).toEqual([A, B].sort())
    expect(db.rows('orders').map((o) => o.status)).toEqual(['completed', 'completed'])
    // #234 (folded in from the deleted 234-reconcile-stamps-paid-at suite): paid_at is stamped, so
    // the paid-but-never-issued receipt sweep can see these orders.
    expect(db.rows('orders').every((o) => typeof o.paid_at === 'string')).toBe(true)
    const ledger = db.rows('payment_events')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ business_order_no: REF, amount: 150 })
    expect((ledger[0].raw_gateway_response as Row).recorded_by).toBe('server')
    expect(audits(db, 'payment.settlement_applied')).toHaveLength(1)
    const staff = audits(db, 'payment.staff_reconciled')
    expect(staff.map((a) => a.entity_id).sort()).toEqual([A, B].sort())
    expect((staff[0].metadata as Row).staffUserId).toBe(STAFF)
    // settled_charge_cents is what the projection reads as `paid`.
    expect(db.rows('orders').map((o) => o.settled_charge_cents).sort()).toEqual([10000, 5000].sort())
    const call0 = settleCalls(db)[0].args as Row
    expect(call0.p_gateway_amount_cents).toBe(15000)
    expect(call0.p_allow_cancelled_recovery).toEqual([])
  })

  it('derives the reference from the orders when staff do not name one', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B] })
    expect(r.status).toBe(200)
    expect(paidIds(db)).toEqual([A, B].sort())
  })

  it('settles an intent reference naming exactly these orders, and consumes the intent', async () => {
    const db = seedPair({
      terminal_payment_intents: [intent({ merchant_order_no: 'FT-INTENT-1', amount_cents: 15000, order_ids: [A, B] })],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))

    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-INTENT-1' })

    expect({ status: r.status, applied: r.body.applied }).toEqual({ status: 200, applied: true })
    expect(paidIds(db)).toEqual([A, B].sort())
    expect(db.rows('terminal_payment_intents')[0].consumed_at).toBeTruthy()
  })
})

describe('invalid reference', () => {
  it('refuses a reference no intent or order carries, without asking the gateway', async () => {
    const db = seedPair()
    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-NOBODY' })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_UNKNOWN' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })

  it('refuses orders that carry no prepared reference at all (no invented fallback)', async () => {
    const db = seedPair({}, { a: { paycloud_merchant_order_no: null } })
    const r = await call({ orderIds: [A, B] })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_UNKNOWN' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })

  it('refuses another order\'s paid reference attached to these orders, even when the amount coincides', async () => {
    // C (N$100) was prepared with its own reference and the customer paid it. A is also N$100.
    const db = seedPair({
      orders: [order(C, { paycloud_merchant_order_no: 'FT-REF-C', pending_charge_cents: 10000 })],
    }, { a: { pending_settlement_id: null, paycloud_merchant_order_no: null }, b: { pending_settlement_id: null } })
    mockQuery.mockResolvedValue(finaticPaid(100))

    const r = await call({ orderIds: [A], merchantOrderNo: 'FT-REF-C' })

    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_NOT_FOR_THESE_ORDERS' })
    expect(paidIds(db)).toEqual([])
    expect(settleCalls(db)).toHaveLength(0)
  })

  it('refuses a SUBSET of the prepared set (the Riviera shape)', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(100))
    const r = await call({ orderIds: [A], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_NOT_FOR_THESE_ORDERS' })
    expect(paidIds(db)).toEqual([])
  })

  it('refuses an intent that names different orders', async () => {
    const db = seedPair({
      terminal_payment_intents: [intent({ merchant_order_no: 'FT-INTENT-1', amount_cents: 10000, order_ids: [A] })],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-INTENT-1' })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_NOT_FOR_THESE_ORDERS' })
    expect(paidIds(db)).toEqual([])
  })
})

describe('another restaurant', () => {
  it('refuses another venue\'s order reference', async () => {
    const db = seedPair({
      orders: [order(X, { restaurant_id: OTHER_VENUE, paycloud_merchant_order_no: 'FT-OTHER', total: 150 })],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-OTHER' })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 403, code: 'REFERENCE_NOT_FOR_RESTAURANT' })
    expect(paidIds(db)).toEqual([])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('refuses another venue\'s intent reference', async () => {
    const db = seedPair({
      terminal_payment_intents: [
        intent({ merchant_order_no: 'FT-OTHER-INTENT', restaurant_id: OTHER_VENUE, amount_cents: 15000, order_ids: [A, B] }),
      ],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-OTHER-INTENT' })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 403, code: 'REFERENCE_NOT_FOR_RESTAURANT' })
    expect(paidIds(db)).toEqual([])
  })

  it('refuses a request naming another venue\'s order', async () => {
    const db = seedPair({ orders: [order(X, { restaurant_id: OTHER_VENUE })] })
    const r = await call({ orderIds: [A, X], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 404, code: 'ORDERS_NOT_FOUND' })
    expect(paidIds(db)).toEqual([])
  })
})

describe('already consumed', () => {
  it('refuses a reference whose intent was already consumed', async () => {
    const db = seedPair({
      terminal_payment_intents: [
        intent({ merchant_order_no: 'FT-INTENT-1', amount_cents: 15000, order_ids: [A, B], consumed_at: '2026-09-28T10:00:00Z', status: 'confirmed' }),
      ],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: 'FT-INTENT-1' })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_ALREADY_CONSUMED' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })

  it('refuses a reference that already has a server-verified ledger row', async () => {
    const db = seedPair({
      payment_events: [
        { id: 'pe-1', restaurant_id: VENUE, event_type: 'sale', business_order_no: REF, idempotency_key: REF,
          transaction_id: 'TXN-OLD', amount: 150, order_ids: [A, B], origin: null,
          raw_gateway_response: { recorded_by: 'server' } },
      ],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_ALREADY_CONSUMED' })
    expect(paidIds(db)).toEqual([])
  })

  it('refuses a reference that already paid another order', async () => {
    const db = seedPair({
      orders: [order(C, { payment_status: 'paid', status: 'completed', payment_reference: REF })],
    })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_ALREADY_CONSUMED' })
    expect(paidIds(db)).toEqual([C])
  })

  it('refuses when the gateway transaction is already recorded under another reference', async () => {
    const db = seedPair({
      payment_events: [
        { id: 'pe-2', restaurant_id: VENUE, event_type: 'sale', business_order_no: 'FT-SOMETHING-ELSE',
          idempotency_key: 'FT-SOMETHING-ELSE', transaction_id: 'TXN-DUP', amount: 150, order_ids: [C],
          origin: 'terminal_device' },
      ],
    })
    mockQuery.mockResolvedValue(finaticPaid(150, 'TXN-DUP'))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'REFERENCE_ALREADY_CONSUMED' })
    expect(r.body.consumedBy).toBe('transaction_id')
    expect(paidIds(db)).toEqual([])
  })

  it('a DEVICE report for the reference does not consume it -- verifying it is the point (control)', async () => {
    const db = seedPair({
      payment_events: [
        { id: 'pe-3', restaurant_id: VENUE, event_type: 'sale', business_order_no: REF, idempotency_key: REF,
          transaction_id: 'TXN-OK', amount: 150, order_ids: [A, B], origin: 'terminal_device',
          device_amount_check: 'matched_order_totals', raw_gateway_response: { any: 'device' } },
      ],
    })
    mockQuery.mockResolvedValue(finaticPaid(150, 'TXN-OK'))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, applied: r.body.applied }).toEqual({ status: 200, applied: true })
    expect(paidIds(db)).toEqual([A, B].sort())
    // One sale row: the device's report, PROMOTED by the settlement (20260929130000).
    expect(db.rows('payment_events')).toHaveLength(1)
    expect(db.rows('payment_events')[0].origin).toBe('gateway')
  })
})

describe('duplicate reconciliation', () => {
  it('the second identical reconciliation is a no-op: one settlement, one ledger row', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(150))

    const first = await call({ orderIds: [A, B], merchantOrderNo: REF })
    const second = await call({ orderIds: [A, B], merchantOrderNo: REF })

    expect({ status: first.status, applied: first.body.applied }).toEqual({ status: 200, applied: true })
    expect({ status: second.status, applied: second.body.applied, outcome: second.body.outcome }).toEqual({
      status: 200,
      applied: false,
      outcome: 'already_paid',
    })
    expect(settleCalls(db)).toHaveLength(1)
    expect(db.rows('payment_events')).toHaveLength(1)
    expect(audits(db, 'payment.staff_reconciled')).toHaveLength(2)
  })
})

describe('the verified set is pinned', () => {
  it('refuses, applying nothing, when the settlement group changes between verification and settlement', async () => {
    // While Finatic is being asked, B leaves the group and C (also N$50) joins it. The re-resolved
    // target {A, C} sums to the same N$150 -- only the pin tells it apart from the verified {A, B}.
    const GROUP = 'dddddddd-0000-4000-8000-000000000001'
    const db = seedPair({
      orders: [order(C, { total: 50, items: [{ name: 'Soda', quantity: 1, unitPrice: 50, total: 50 }], pending_charge_cents: 5000 })],
    })
    mockQuery.mockImplementation(async () => {
      const rows = db.rows('orders')
      rows.find((o) => o.id === B)!.pending_settlement_id = null
      rows.find((o) => o.id === C)!.pending_settlement_id = GROUP
      return finaticPaid(150)
    })

    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })

    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'SETTLEMENT_TARGET_CHANGED' })
    expect(paidIds(db)).toEqual([])
    expect(settleCalls(db)).toHaveLength(0)
  })
})

describe('authorization', () => {
  it('an unauthorized caller is refused before anything is read or asked', async () => {
    const db = seedPair()
    mockAuthDenied = true
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    // The auth layer's own refusal, passed through -- not some later check that happens to refuse.
    expect({ status: r.status, error: r.body.error }).toEqual({ status: 401, error: 'Authentication required.' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })

  it('a caller naming another restaurant is refused', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ restaurantId: OTHER_VENUE, orderIds: [A, B], merchantOrderNo: REF })
    expect(r.status).toBe(403)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })
})

describe('order state', () => {
  it('refuses a cancelled order (cancelled -> paid used to work)', async () => {
    const db = seedPair({}, { b: { status: 'cancelled', payment_status: 'cancelled', cancellation_reason: 'staff_cancelled' } })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'ORDER_NOT_CLAIMABLE' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(db)).toEqual([])
  })

  it('refuses an E04111-auto-cancelled order too -- staff reconcile never revives a cancel', async () => {
    const db = seedPair({}, { b: { status: 'cancelled', payment_status: 'cancelled', cancellation_reason: 'auto_cancelled_e04111_persisted' } })
    mockQuery.mockResolvedValue(finaticPaid(150))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'ORDER_NOT_CLAIMABLE' })
    expect(paidIds(db)).toEqual([])
  })

  it('refuses a set that is partly paid already', async () => {
    const db = seedPair({}, { b: { payment_status: 'paid', status: 'completed' } })
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'ORDERS_PARTIALLY_PAID' })
    expect(paidIds(db)).toEqual([B])
  })
})

describe('amount: the projection\'s outstanding, exact', () => {
  /** A: two lines N$60 + N$40, the N$40 line voided after the charge was prepared at N$100. */
  function seedVoided(pendingChargeCents: number) {
    return seedPair(
      {
        order_lines: [
          { id: 'l1', order_id: A, source_item_index: 0, kitchen_state: 'outstanding', bar_state: null },
          { id: 'l2', order_id: A, source_item_index: 1, kitchen_state: 'voided', bar_state: null },
        ],
      },
      {
        a: {
          pending_settlement_id: null,
          pending_charge_cents: pendingChargeCents,
          items: [
            { name: 'Steak', quantity: 1, unitPrice: 60, total: 60 },
            { name: 'Wine', quantity: 1, unitPrice: 40, total: 40 },
          ],
        },
        b: { pending_settlement_id: null },
      },
    )
  }

  it('refuses orders.total when a line has been voided (stale N$100 against N$60 owed)', async () => {
    const db = seedVoided(10000)
    mockQuery.mockResolvedValue(finaticPaid(100))
    const r = await call({ orderIds: [A], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'AMOUNT_UNVERIFIED' })
    expect(r.body.expectedAmount).toBe(60)
    expect(paidIds(db)).toEqual([])
  })

  it('settles the live figure when the prepared charge was the live figure', async () => {
    const db = seedVoided(6000)
    mockQuery.mockResolvedValue(finaticPaid(60))
    const r = await call({ orderIds: [A], merchantOrderNo: REF })
    expect({ status: r.status, applied: r.body.applied }).toEqual({ status: 200, applied: true })
    expect(paidIds(db)).toEqual([A])
  })

  it('refuses a one-cent difference and leaves one audit row per order with both figures', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(150.01))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'AMOUNT_UNVERIFIED' })
    const rows = audits(db, 'payment.verification_uncertain')
    expect(rows.map((a) => a.entity_id).sort()).toEqual([A, B].sort())
    expect(rows[0].metadata).toMatchObject({ finaticAmount: 150.01, expectedAmount: 150, amountVerified: false })
    expect(paidIds(db)).toEqual([])
  })

  it('treats an absent gateway amount as unverified, recorded as null', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticPaid(null))
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect(r.status).toBe(409)
    expect((audits(db, 'payment.verification_uncertain')[0].metadata as Row).finaticAmount).toBeNull()
    expect(paidIds(db)).toEqual([])
  })
})

describe('the gateway says no', () => {
  it('not paid: nothing written', async () => {
    const db = seedPair()
    mockQuery.mockResolvedValue(finaticNotPaid())
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, paid: r.body.paid }).toEqual({ status: 200, paid: false })
    expect(paidIds(db)).toEqual([])
    expect(settleCalls(db)).toHaveLength(0)
  })

  it('E04111: no record yet, nothing written', async () => {
    const db = seedPair()
    mockQuery.mockRejectedValue(e04111Error())
    const r = await call({ orderIds: [A, B], merchantOrderNo: REF })
    expect({ status: r.status, paid: r.body.paid }).toEqual({ status: 200, paid: false })
    expect(paidIds(db)).toEqual([])
  })
})
