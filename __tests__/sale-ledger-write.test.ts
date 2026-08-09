/**
 * #156 — the settle route must write the SALE ledger row itself.
 *
 * Before this change the settle route set payment_status server-side and wrote NO ledger entry
 * at all; the SALE row came from a separate client call at TableDetailScreen.tsx:308, guarded
 * on two fields, unawaited, unretried, reporting failure to a console.warn in a worker that
 * had no logging. 294 card payments across four venues have no SALE row as a result.
 *
 * The load-bearing assertions here are the counts: a card settle must produce EXACTLY ONE sale
 * row and a cash settle must produce NONE. Both are run against a fake that enforces the real
 * payment_events constraints (see helpers/fake-payment-events-db.ts), so a write that would be
 * rejected by production is rejected here too.
 */
import {
  FakeDb,
  validatePaymentEvent,
  type FakeRow,
} from './helpers/fake-payment-events-db'
import {
  isLedgerGapOutcome,
  recordSettlementSaleEvent,
  SALE_LEDGER_WRITE_FAILED_ACTION,
  SALE_LEDGER_WRITE_SKIPPED_ACTION,
  SETTLE_CARD_REASON_CODE,
} from '@/lib/payments/record-settlement-sale-event'

const RESTAURANT = 'rest-1'
const ORDER_A = 'order-a'
const ORDER_B = 'order-b'

function params(overrides: Partial<Parameters<typeof recordSettlementSaleEvent>[1]> = {}) {
  return {
    restaurantId: RESTAURANT,
    orderIds: [ORDER_A],
    method: 'card' as const,
    businessOrderNo: 'FT1785738099890',
    transactionId: 'FT1785738099890',
    amount: 35,
    terminalId: 'term-1',
    initiatedBy: null,
    tabId: 'tab-1',
    logPrefix: '[test]',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * The control on the control. If these pass with a permissive fake,
 * every assertion below is worthless.
 * ------------------------------------------------------------------ */
describe('the fake enforces the constraints it claims to', () => {
  const legal: FakeRow = {
    restaurant_id: RESTAURANT,
    order_ids: [ORDER_A],
    event_type: 'sale',
    business_order_no: 'FT1',
    origin_business_order_no: 'FT1',
    amount: 10,
    idempotency_key: 'FT1',
    reason_code: 'sale',
  }

  it('accepts a legal sale row', () => {
    expect(validatePaymentEvent(legal, [])).toBeNull()
  })

  it('rejects event_type "settle_card" — it is NOT in the CHECK constraint', () => {
    // The classification decision is settle_card semantics, but event_type cannot carry it.
    const err = validatePaymentEvent({ ...legal, event_type: 'settle_card' }, [])
    expect(err?.code).toBe('23514')
  })

  it('rejects a null business_order_no', () => {
    expect(validatePaymentEvent({ ...legal, business_order_no: null }, [])?.code).toBe('23502')
  })

  it('rejects a non-positive amount', () => {
    expect(validatePaymentEvent({ ...legal, amount: 0 }, [])?.code).toBe('23514')
  })

  it('rejects an empty order_ids array', () => {
    expect(validatePaymentEvent({ ...legal, order_ids: [] }, [])?.code).toBe('23514')
  })

  it('rejects the singular order_id column — a later migration removed it', () => {
    expect(validatePaymentEvent({ ...legal, order_id: ORDER_A }, [])?.code).toBe('42703')
  })

  it('rejects a duplicate (restaurant_id, idempotency_key) with 23505', () => {
    expect(validatePaymentEvent(legal, [legal])?.code).toBe('23505')
  })

  it('does NOT reject a duplicate key at a different restaurant', () => {
    expect(validatePaymentEvent(legal, [{ ...legal, restaurant_id: 'rest-2' }])).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Card: exactly one row.
 * ------------------------------------------------------------------ */
describe('card settlement writes exactly one SALE row', () => {
  it('records the sale', async () => {
    const db = new FakeDb()
    const result = await recordSettlementSaleEvent(db.client() as never, params())

    expect(result.outcome).toBe('recorded')
    expect(db.saleRows()).toHaveLength(1)
  })

  it('writes event_type "sale" and carries the settle origin in reason_code', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params())

    const row = db.saleRows()[0]
    expect(row.event_type).toBe('sale')
    expect(row.reason_code).toBe(SETTLE_CARD_REASON_CODE)
  })

  it('links the row to every claimed order via order_ids', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(
      db.client() as never,
      params({ orderIds: [ORDER_A, ORDER_B] }),
    )

    expect(db.saleRows()[0].order_ids).toEqual([ORDER_A, ORDER_B])
  })

  it('uses business_order_no as the idempotency key', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params())

    const row = db.saleRows()[0]
    expect(row.idempotency_key).toBe('FT1785738099890')
    expect(row.origin_business_order_no).toBe('FT1785738099890')
  })

  it('writes initiated_by null when no staff member was PIN-verified', async () => {
    // 20260705360000 dropped the NOT NULL specifically so sale rows can be written without a
    // human actor. Nothing is invented to fill it.
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params())

    expect(db.saleRows()[0].initiated_by).toBeNull()
  })

  it('writes the real user id when one WAS PIN-verified', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ initiatedBy: 'user-7' }))

    expect(db.saleRows()[0].initiated_by).toBe('user-7')
  })

  it('falls back to business_order_no for transaction_id, matching order #120', async () => {
    // The known-good control row has transaction_id identical to business_order_no: the
    // terminal sends the merchant order number as both.
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ transactionId: '' }))

    expect(db.saleRows()[0].transaction_id).toBe('FT1785738099890')
  })

  it('records the server amount it was given, not a client-supplied one', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ amount: 42.5 }))

    expect(db.saleRows()[0].amount).toBe(42.5)
  })
})

/* ------------------------------------------------------------------ *
 * Cash: none. This is the regression that must not happen.
 * ------------------------------------------------------------------ */
describe('cash settlement is excluded and unchanged', () => {
  it('writes NO sale row for cash', async () => {
    const db = new FakeDb()
    const result = await recordSettlementSaleEvent(
      db.client() as never,
      params({ method: 'cash', businessOrderNo: '', transactionId: '' }),
    )

    expect(result.outcome).toBe('skipped_cash')
    expect(db.saleRows()).toHaveLength(0)
  })

  it('touches the database not at all for cash', async () => {
    // Cash is the path a merchant uses daily and the one verified on hardware. The exclusion
    // returns before any query, so there is no new failure mode on it whatsoever.
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ method: 'cash' }))

    expect(db.insertAttempts).toHaveLength(0)
  })

  it('does not raise a ledger-gap alert for cash', async () => {
    // Cash producing no row is correct, not a defect. Alerting on it every time would train
    // everyone to ignore this alert, which is how the original failure stayed invisible.
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ method: 'cash' }))

    expect(db.auditRows(SALE_LEDGER_WRITE_FAILED_ACTION)).toHaveLength(0)
    expect(db.auditRows(SALE_LEDGER_WRITE_SKIPPED_ACTION)).toHaveLength(0)
  })

  it('never invents a synthetic reference for cash', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(
      db.client() as never,
      // Even if a client wrongly sends a reference alongside cash.
      params({ method: 'cash', businessOrderNo: 'FT-SHOULD-NOT-BE-USED' }),
    )

    expect(db.tables.payment_events).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Idempotency — including free dedup against the terminal's own post.
 * ------------------------------------------------------------------ */
describe('idempotency', () => {
  it('a retried settle does not double-record', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params())
    const second = await recordSettlementSaleEvent(db.client() as never, params())

    expect(second.outcome).toBe('already_recorded')
    expect(db.saleRows()).toHaveLength(1)
  })

  it('dedups against a row the terminal posted first for the same reference', async () => {
    // The terminal's /payment-events/sale route uses the same idempotency_key, so the UNIQUE
    // constraint collapses the two paths onto one row whichever lands first.
    const db = new FakeDb()
    db.tables.payment_events.push({
      id: 'pe-terminal',
      restaurant_id: RESTAURANT,
      order_ids: [ORDER_A],
      event_type: 'sale',
      business_order_no: 'FT1785738099890',
      origin_business_order_no: 'FT1785738099890',
      amount: 35,
      idempotency_key: 'FT1785738099890',
      reason_code: 'sale',
    })

    const result = await recordSettlementSaleEvent(db.client() as never, params())

    expect(result.outcome).toBe('already_recorded')
    expect(db.saleRows()).toHaveLength(1)
  })

  it('raises a conflict when the same reference already records a DIFFERENT amount', async () => {
    const db = new FakeDb()
    db.tables.payment_events.push({
      id: 'pe-other',
      restaurant_id: RESTAURANT,
      order_ids: [ORDER_A],
      event_type: 'sale',
      business_order_no: 'FT1785738099890',
      origin_business_order_no: 'FT1785738099890',
      amount: 999,
      idempotency_key: 'FT1785738099890',
      reason_code: 'sale',
    })

    const result = await recordSettlementSaleEvent(db.client() as never, params())

    expect(result.outcome).toBe('conflict')
    expect(isLedgerGapOutcome(result.outcome)).toBe(true)
    expect(db.auditRows(SALE_LEDGER_WRITE_FAILED_ACTION)).toHaveLength(1)
  })

  it('raises a conflict when the same reference already records DIFFERENT orders', async () => {
    const db = new FakeDb()
    db.tables.payment_events.push({
      id: 'pe-other',
      restaurant_id: RESTAURANT,
      order_ids: ['some-other-order'],
      event_type: 'sale',
      business_order_no: 'FT1785738099890',
      origin_business_order_no: 'FT1785738099890',
      amount: 35,
      idempotency_key: 'FT1785738099890',
      reason_code: 'sale',
    })

    const result = await recordSettlementSaleEvent(db.client() as never, params())

    expect(result.outcome).toBe('conflict')
  })
})

/* ------------------------------------------------------------------ *
 * A failed write must never be silent — and must never fail the settle.
 * ------------------------------------------------------------------ */
describe('a failed ledger write is loud, durable, and non-fatal', () => {
  const outage = { message: 'connection terminated unexpectedly', code: '08006' }

  it('does not throw when the insert fails', async () => {
    const db = new FakeDb({ failInsertOn: { payment_events: outage } })
    await expect(
      recordSettlementSaleEvent(db.client() as never, params()),
    ).resolves.toMatchObject({ outcome: 'failed' })
  })

  it('writes an audit_logs row the ops console can alert on', async () => {
    const db = new FakeDb({ failInsertOn: { payment_events: outage } })
    await recordSettlementSaleEvent(db.client() as never, params())

    const audits = db.auditRows(SALE_LEDGER_WRITE_FAILED_ACTION)
    expect(audits).toHaveLength(1)
    expect(audits[0].restaurant_id).toBe(RESTAURANT)
    const meta = audits[0].metadata as Record<string, unknown>
    expect(meta.severity).toBe('critical')
    expect(meta.requiresAttention).toBe(true)
    expect(meta.businessOrderNo).toBe('FT1785738099890')
    expect(meta.error).toContain('connection terminated')
  })

  it('logs at error level with a structured marker carrying severity', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = new FakeDb({ failInsertOn: { payment_events: outage } })
      await recordSettlementSaleEvent(db.client() as never, params())

      const payloads = spy.mock.calls.map((c) => String(c[1] ?? ''))
      const marker = payloads.find((p) => p.includes(SALE_LEDGER_WRITE_FAILED_ACTION))
      expect(marker).toBeDefined()
      const parsed = JSON.parse(marker!)
      expect(parsed.severity).toBe('critical')
      expect(parsed.requiresAttention).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('still shouts when the audit write ALSO fails — the last line before invisibility', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = new FakeDb({
        failInsertOn: { payment_events: outage, audit_logs: { message: 'audit down' } },
      })
      const result = await recordSettlementSaleEvent(db.client() as never, params())

      expect(result.outcome).toBe('failed')
      const payloads = spy.mock.calls.map((c) => String(c[1] ?? ''))
      expect(payloads.some((p) => p.includes('payment.sale_ledger_audit_failed'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

/* ------------------------------------------------------------------ *
 * A card settle with no reference is a gap, and must be as visible as
 * a failure. The old client guard skipped this case silently.
 * ------------------------------------------------------------------ */
describe('a card settlement with nothing to record under is a LOUD skip', () => {
  it('skips rather than inventing a reference', async () => {
    const db = new FakeDb()
    const result = await recordSettlementSaleEvent(
      db.client() as never,
      params({ businessOrderNo: '', transactionId: '' }),
    )

    expect(result).toEqual({ outcome: 'skipped', reason: 'missing_business_order_no' })
    expect(db.saleRows()).toHaveLength(0)
  })

  it('audits the skip — the old console.warn left no trace at all', async () => {
    const db = new FakeDb()
    await recordSettlementSaleEvent(db.client() as never, params({ businessOrderNo: '' }))

    const audits = db.auditRows(SALE_LEDGER_WRITE_SKIPPED_ACTION)
    expect(audits).toHaveLength(1)
    expect((audits[0].metadata as Record<string, unknown>).reason).toBe(
      'missing_business_order_no',
    )
    expect((audits[0].metadata as Record<string, unknown>).requiresAttention).toBe(true)
  })

  it('skips a non-positive amount with a reason rather than hitting the CHECK', async () => {
    const db = new FakeDb()
    const result = await recordSettlementSaleEvent(db.client() as never, params({ amount: 0 }))

    expect(result).toEqual({ outcome: 'skipped', reason: 'non_positive_amount' })
    expect(db.auditRows(SALE_LEDGER_WRITE_SKIPPED_ACTION)).toHaveLength(1)
  })

  it('classifies every gap outcome as a gap, and the good ones as not', async () => {
    expect(isLedgerGapOutcome('failed')).toBe(true)
    expect(isLedgerGapOutcome('skipped')).toBe(true)
    expect(isLedgerGapOutcome('conflict')).toBe(true)
    expect(isLedgerGapOutcome('recorded')).toBe(false)
    expect(isLedgerGapOutcome('already_recorded')).toBe(false)
    // Cash is not a gap. If this ever flips, every cash settle raises a critical alert.
    expect(isLedgerGapOutcome('skipped_cash')).toBe(false)
  })
})
