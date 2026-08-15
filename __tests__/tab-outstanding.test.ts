import { computeTabGrossOrdered, computeTabOutstanding } from '@/lib/tabs/tab-outstanding'

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
