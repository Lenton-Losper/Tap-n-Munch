import {
  computeTabFigures,
  computeTabGrossOrdered,
  computeTabOutstanding,
  computeTabPending,
} from '@/lib/tabs/tab-outstanding'

/**
 * The two definitions that were living in one column.
 *
 * Measured on production 2026-08-15: of 20 tabs carrying orders, `tabs.total` matched "gross
 * ordered" on 13 and "still outstanding" on 6, decided by whichever of its five writers touched
 * the row last. The pair of tests below is the whole point of the module -- the same rows must
 * produce two DIFFERENT numbers, and the authoritative one is outstanding.
 */
describe('computeTabOutstanding — what the table owes now', () => {
  const rows = [
    { total: 100, payment_status: 'pending' },          // owed
    { total: 150, payment_status: 'paid' },             // settled
    { total: 40, payment_status: 'cancelled' },         // QRA-15: never owed
    { total: 25, payment_status: 'cash_pending' },      // owed
    { total: 60, payment_status: 'failed' },            // owed — a failed payment is still due
    { total: 80, payment_status: 'terminal_pending' },  // owed — a card attempt is not a payment
  ]

  it('counts only what is still owed', () => {
    expect(computeTabOutstanding(rows)).toBe(265)
  })

  it('excludes a CANCELLED order — the defect that had no re-sum at all (QRA-15)', () => {
    const withCancel = [{ total: 100, payment_status: 'pending' }, { total: 40, payment_status: 'cancelled' }]
    expect(computeTabOutstanding(withCancel)).toBe(100)
  })

  it('excludes a PAID order, so paying does not leave the money on the bill', () => {
    expect(computeTabOutstanding([{ total: 100, payment_status: 'paid' }])).toBe(0)
  })

  /**
   * A settlement artefact represents a PAYMENT of a tab, not a line the table ordered. Counting
   * an unpaid one would double the bill. Deliberately stricter than the terminal settle route,
   * and bounded by measurement: zero such rows existed on staging or production on 2026-08-15.
   */
  it('excludes a settlement artefact even when it still owes money', () => {
    const rows = [
      { total: 100, payment_status: 'pending' },
      { total: 100, payment_status: 'pending', tab_settlement_for_tab_id: 'tab-1' },
    ]
    expect(computeTabOutstanding(rows)).toBe(100)
  })

  it('rounds to cents rather than accumulating a float artefact', () => {
    const rows = Array.from({ length: 3 }, () => ({ total: 0.1, payment_status: 'pending' }))
    expect(computeTabOutstanding(rows)).toBe(0.3)
  })

  it('is 0, never NaN, for no rows or unusable totals', () => {
    expect(computeTabOutstanding([])).toBe(0)
    expect(computeTabOutstanding(null)).toBe(0)
    expect(computeTabOutstanding(undefined)).toBe(0)
    expect(computeTabOutstanding([{ total: 'not a number', payment_status: 'pending' }])).toBe(0)
  })

  it('treats an unknown payment status as NOT owed, so a new status fails closed', () => {
    // owesMoney is an allowlist. A status nobody has taught it about must not silently become
    // money the customer is told they owe.
    expect(computeTabOutstanding([{ total: 100, payment_status: 'some_new_status' }])).toBe(0)
  })
})

describe('computeTabGrossOrdered — a DIFFERENT question, under its own name', () => {
  it('counts paid and cancelled orders too, which is why it must never be labelled "what you owe"', () => {
    const rows = [
      { total: 100, payment_status: 'pending' },
      { total: 150, payment_status: 'paid' },
      { total: 40, payment_status: 'cancelled' },
    ]
    expect(computeTabGrossOrdered(rows)).toBe(290)
    // The pair that matters: same rows, two answers. Conflating them is the bug this replaces.
    expect(computeTabOutstanding(rows)).toBe(100)
  })

  it('still excludes settlement artefacts — they are payments, not orders', () => {
    expect(
      computeTabGrossOrdered([
        { total: 100, payment_status: 'paid' },
        { total: 100, payment_status: 'paid', tab_settlement_for_tab_id: 'tab-1' },
      ]),
    ).toBe(100)
  })
})

/**
 * PENDING — submitted, not yet answered. The whole reason this exists: every QR submission is an
 * `order_requests` row until staff Accept, so a tab with two live orders and nothing accepted had
 * a payable of 0 and showed the customer NAD0.00 while they were holding N$132 of food.
 */
describe('computeTabPending — submitted, not yet answered', () => {
  it('counts waiting_review only', () => {
    expect(
      computeTabPending([
        { status: 'waiting_review', total: 107 },
        { status: 'waiting_review', total: 25 },
      ]),
    ).toBe(132)
  })

  it('excludes DECLINED explicitly — the restaurant answered no', () => {
    expect(
      computeTabPending([
        { status: 'waiting_review', total: 25 },
        { status: 'declined', total: 20 },
      ]),
    ).toBe(25)
  })

  /**
   * The double-count guard. Accept claims the request into `accepting` BEFORE inserting the order,
   * so by the time an order exists the request is out of this set. If either ever counted it, the
   * same money would appear in payable and pending at once.
   */
  it('excludes accepting and accepted, so money is never in both figures', () => {
    expect(
      computeTabPending([
        { status: 'accepting', total: 50 },
        { status: 'accepted', total: 60 },
      ]),
    ).toBe(0)
  })

  it('prices through effectiveRequestPricing — a staff review beats the original', () => {
    expect(
      computeTabPending([
        { status: 'waiting_review', total: 100, items_reviewed: [], total_reviewed: 80 },
      ]),
    ).toBe(80)
  })

  it('is 0, never NaN, for junk', () => {
    expect(computeTabPending(null)).toBe(0)
    expect(computeTabPending([])).toBe(0)
    expect(computeTabPending([{ status: 'waiting_review', total: 'x' }])).toBe(0)
  })
})

describe('computeTabFigures — the two together', () => {
  it('keeps them separate: the same money never lands in both', () => {
    const orders = [{ total: 25, payment_status: 'pending' }]
    const requests = [
      { status: 'waiting_review', total: 107 },
      { status: 'accepted', total: 25 },
    ]
    expect(computeTabFigures(orders, requests)).toEqual({ payable: 25, pending: 107 })
  })

  it('reproduces the reported tab: two live requests, nothing accepted', () => {
    // table 120, tab b513a80c: payable was 0 and the strip read NAD0.00.
    const figures = computeTabFigures([], [
      { status: 'waiting_review', total: 107 },
      { status: 'waiting_review', total: 25 },
    ])
    expect(figures.payable).toBe(0)
    expect(figures.pending).toBe(132)
    expect(figures.payable + figures.pending).toBe(132)
  })
})
