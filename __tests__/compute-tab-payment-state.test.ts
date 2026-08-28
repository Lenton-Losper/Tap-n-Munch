import { computeTabPaymentState } from '@/lib/payments/payment-integrity'

/**
 * Digi Cofee, 2026-08-28: three waiter rounds were wrongly auto-cancelled (see
 * stale-pos-sweep-excludes-live-tabs.test.ts for that fix), unpaid_total read 0, and the tab
 * rendered "Paid in full - table still open" over three cancelled, unpaid drinks. Nobody paid
 * anything.
 *
 * unpaid_total === 0 is true both when everything was genuinely settled and when everything was
 * cancelled first -- this proves the two are distinguished at the source.
 */
describe('computeTabPaymentState', () => {
  it('an all-cancelled tab reads "cancelled", never "paid" -- the Digi Cofee case', () => {
    const state = computeTabPaymentState([
      { payment_status: 'cancelled' },
      { payment_status: 'cancelled' },
      { payment_status: 'cancelled' },
    ])

    expect(state).toBe('cancelled')
    expect(state).not.toBe('paid')
  })

  it('a genuinely settled tab reads "paid"', () => {
    const state = computeTabPaymentState([{ payment_status: 'paid' }, { payment_status: 'paid' }])
    expect(state).toBe('paid')
  })

  it('paid alongside a cancelled sibling still reads "paid" -- money WAS collected for what was owed', () => {
    const state = computeTabPaymentState([
      { payment_status: 'paid' },
      { payment_status: 'cancelled' },
    ])
    expect(state).toBe('paid')
  })

  it('anything still owed reads "unpaid", regardless of a paid or cancelled sibling', () => {
    expect(computeTabPaymentState([{ payment_status: 'pending' }])).toBe('unpaid')
    expect(
      computeTabPaymentState([{ payment_status: 'paid' }, { payment_status: 'pending' }]),
    ).toBe('unpaid')
    expect(
      computeTabPaymentState([{ payment_status: 'cancelled' }, { payment_status: 'cash_pending' }]),
    ).toBe('unpaid')
  })

  it('a tab with no orders yet reads "no_orders", not "paid"', () => {
    expect(computeTabPaymentState([])).toBe('no_orders')
  })

  it('a mid-flight or held payment status counts as unpaid, not paid', () => {
    expect(computeTabPaymentState([{ payment_status: 'terminal_pending' }])).toBe('unpaid')
    expect(computeTabPaymentState([{ payment_status: 'amount_mismatch_hold' }])).toBe('unpaid')
  })
})
