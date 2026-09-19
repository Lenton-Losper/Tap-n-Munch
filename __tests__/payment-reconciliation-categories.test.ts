/**
 * RECONCILIATION — every category, including the ones that must NOT fire.
 *
 * The classifier is a pure function precisely so each category can be proved directly instead of
 * inferred from what a query happened to return. The two things that would make this report
 * useless are both asserted here:
 *
 *   a finding that never fires   -- a category nothing can reach is a category that hides a class
 *                                   of anomaly behind a plausible-looking zero
 *   a finding that always fires  -- cash orders reported as "missing ledger" would bury the 1,630
 *                                   genuine card gaps under several hundred false ones
 */
import {
  classifyOrder,
  summarise,
  RECONCILIATION_CATEGORIES,
  type ReconciliationCategory,
} from '@/lib/payments/reconciliation'

type Order = Parameters<typeof classifyOrder>[0]['order']

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    order_number: 155,
    restaurant_id: 'rest-1',
    payment_status: 'paid',
    payment_method: 'card',
    total: 500,
    paid_at: '2026-09-18T16:37:39Z',
    placed_at: '2026-09-18T16:00:00Z',
    paycloud_merchant_order_no: 'FT1788784629859442',
    pending_charge_cents: 50000,
    ...overrides,
  }
}

function sale(amount: number, overrides: Record<string, unknown> = {}) {
  return {
    order_ids: ['ord-1'],
    business_order_no: 'FT1788784629859442',
    transaction_id: 'TXN-1',
    amount,
    event_type: 'sale',
    created_at: '2026-09-18T16:37:40Z',
    ...overrides,
  }
}

const classify = (
  o: Partial<Order> = {},
  ledgerRows: ReturnType<typeof sale>[] = [],
  allocatedCents = 0,
  hasUnresolvedUncertainty = false,
) => classifyOrder({ order: order(o), ledgerRows, allocatedCents, hasUnresolvedUncertainty })

describe('reconciliation categories', () => {
  it('matched: order, ledger and amount all agree', () => {
    const f = classify({}, [sale(500)])
    expect(f.category).toBe('matched')
    expect(f.severity).toBe('ok')
  })

  it('gateway_success_missing_ledger: the 1,630-order gap', () => {
    const f = classify({}, [])
    expect(f.category).toBe('gateway_success_missing_ledger')
    expect(f.severity).toBe('critical')
    expect(f.ledgerAmountCents).toBeNull()
    expect(f.orderAmountCents).toBe(50000)
  })

  it('ledger_missing_gateway: money recorded, order never settled', () => {
    const f = classify({ payment_status: 'pending' }, [sale(500)])
    expect(f.category).toBe('ledger_missing_gateway')
    expect(f.severity).toBe('critical')
  })

  it('amount_mismatch: the ledger and the order disagree', () => {
    const f = classify({}, [sale(720)])
    expect(f.category).toBe('amount_mismatch')
    expect(f.ledgerAmountCents).toBe(72000)
    expect(f.orderAmountCents).toBe(50000)
  })

  it('duplicate: two ledger rows for one order outrank anything either says', () => {
    const f = classify({}, [sale(500), sale(500, { business_order_no: 'FT-OTHER' })])
    expect(f.category).toBe('duplicate')
    expect(f.detail).toMatch(/charged twice/)
  })

  it('missing_merchant_reference: F17’s 331 orders, and it must not invent one', () => {
    const f = classify({ paycloud_merchant_order_no: null }, [])
    expect(f.category).toBe('missing_merchant_reference')
    expect(f.merchantOrderNo).toBeNull()
    expect(f.detail).toMatch(/Do NOT invent one/)
  })

  it('method_mismatch: gateway evidence on a non-card payment (F3)', () => {
    const f = classify({ payment_method: 'cash' }, [sale(500)])
    expect(f.category).toBe('method_mismatch')
  })

  it('verification_uncertain: asked, unanswered, and NOT resolved either way', () => {
    const f = classify({ payment_status: 'pending' }, [], 0, true)
    expect(f.category).toBe('verification_uncertain')
    expect(f.severity).toBe('review')
    // The ruling, restated where an operator will actually read it.
    expect(f.detail).toMatch(/do not mark it paid and do not cancel it/i)
  })

  it('partial_allocation: part-paid by item is expected, not an anomaly', () => {
    const f = classify({ payment_status: 'pending' }, [], 1700)
    expect(f.category).toBe('partial_allocation')
    expect(f.severity).toBe('ok')
    expect(f.allocatedAmountCents).toBe(1700)
  })

  describe('the categories that must NOT fire', () => {
    it('a cash order with no ledger row is NOT a missing-ledger finding', () => {
      /**
       * The single most important negative. `payment_events` is keyed on a gateway reference, so
       * cash has no row by design; reporting those would bury the genuine card gaps under several
       * hundred false ones and the report would stop being read.
       */
      const f = classify({ payment_method: 'cash', paycloud_merchant_order_no: null }, [])
      expect(f.category).toBe('matched')
    })

    it('a PayToday order with no ledger row is likewise not a finding', () => {
      const f = classify({ payment_method: 'paytoday', paycloud_merchant_order_no: null }, [])
      expect(f.category).toBe('matched')
    })

    it('an ordinary unpaid order is not an anomaly', () => {
      const f = classify({ payment_status: 'pending', paycloud_merchant_order_no: null }, [])
      expect(f.category).toBe('matched')
    })

    it('a TIPPED charge is not an amount mismatch', () => {
      /**
       * The expectation is `pending_charge_cents` -- what the reader was asked for -- not
       * `total`. Comparing against the total would report a mismatch on every correctly
       * collected tipped payment, which is the same defect the gateway gates had before
       * lib/payments/expected-charge.ts.
       */
      const f = classify({ total: 500, pending_charge_cents: 53000 }, [sale(530)])
      expect(f.category).toBe('matched')
      expect(f.orderAmountCents).toBe(53000)
    })
  })

  describe('the report as a whole', () => {
    it('every declared category is reachable — none is decorative', () => {
      /**
       * A category nothing can produce is worse than a missing one: it reads as a clean zero for a
       * class of anomaly that is simply never being looked for. `unknown` is the one exception --
       * it is the catch-all, and a classifier with no unclassifiable input is the goal.
       */
      const produced = new Set<ReconciliationCategory>([
        classify({}, [sale(500)]).category,
        classify({}, []).category,
        classify({ payment_status: 'pending' }, [sale(500)]).category,
        classify({}, [sale(720)]).category,
        classify({}, [sale(500), sale(500, { business_order_no: 'X' })]).category,
        classify({ paycloud_merchant_order_no: null }, []).category,
        classify({ payment_method: 'cash' }, [sale(500)]).category,
        classify({ payment_status: 'pending' }, [], 0, true).category,
        classify({ payment_status: 'pending' }, [], 1700).category,
      ])

      const unreachable = RECONCILIATION_CATEGORIES.filter(
        (c) => c !== 'unknown' && !produced.has(c),
      )
      expect(unreachable).toEqual([])
    })

    it('summarise counts every finding and totals the critical money', () => {
      const findings = [
        classify({}, []),
        classify({ id: 'ord-2', payment_status: 'pending' }, [sale(500)]),
        classify({ id: 'ord-3' }, [sale(500)]),
      ]
      const s = summarise(findings)

      expect(s.total).toBe(3)
      expect(s.criticalCount).toBe(2)
      // 50000 + 50000. The figure an operator is being asked to go and find.
      expect(s.criticalAmountCents).toBe(100000)
      expect(s.byCategory.matched.count).toBe(1)
    })

    it('nothing is dropped — the summary counts what the list filters out', () => {
      // A reconciliation that discards what it does not surface looks clean by construction.
      const findings = [classify({}, [sale(500)]), classify({ id: 'ord-2' }, [])]
      const s = summarise(findings)
      expect(s.total).toBe(2)
      expect(Object.values(s.byCategory).reduce((n, b) => n + b.count, 0)).toBe(2)
    })
  })
})
