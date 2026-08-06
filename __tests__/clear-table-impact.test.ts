/**
 * Issue #176 — staff must never clear away money without being told.
 *
 * The confirmation is the only thing standing between a one-click button and owed money
 * silently vanishing from the dashboard, so its counting must agree exactly with what the close
 * route does. The route partitions with isPaidPaymentStatus rather than a raw .eq(), because
 * PostgREST comparisons are byte-exact and a stray 'Paid' would be classified wrongly.
 */
import {
  summariseClearImpact,
  clearTableConfirmationMessage,
  formatClearAmount,
} from '@/lib/tables/clear-table'

describe('#176 clear-table impact summary', () => {
  test('counts an unpaid order and demands confirmation', () => {
    const impact = summariseClearImpact([
      { payment_status: 'paid', total: 50 },
      { payment_status: 'pending', total: 120 },
    ])
    expect(impact.total).toBe(2)
    expect(impact.paid).toBe(1)
    expect(impact.unpaid).toBe(1)
    expect(impact.unpaidTotal).toBe(120)
    expect(impact.requiresConfirmation).toBe(true)
  })

  test('an all-paid table does not demand the money confirmation', () => {
    const impact = summariseClearImpact([
      { payment_status: 'paid', total: 50 },
      { payment_status: 'PAID', total: 20 },
    ])
    expect(impact.unpaid).toBe(0)
    expect(impact.requiresConfirmation).toBe(false)
  })

  test('an empty table is safe', () => {
    const impact = summariseClearImpact([])
    expect(impact.total).toBe(0)
    expect(impact.requiresConfirmation).toBe(false)
    expect(clearTableConfirmationMessage(impact)).toMatch(/no open orders/i)
  })

  test('null and undefined are treated as empty, not as a crash', () => {
    expect(summariseClearImpact(null).total).toBe(0)
    expect(summariseClearImpact(undefined).requiresConfirmation).toBe(false)
  })

  describe('agrees with the route on messy payment_status values', () => {
    // These are the cases a raw .eq('payment_status','paid') would get wrong. If the UI and the
    // route disagree here, the confirmation lies about how much money is at stake.
    test.each([
      ['Paid', false],
      ['PAID', false],
      [' paid', false],
      ['paid ', false],
      ['pending', true],
      ['cancelled', true],
      ['', true],
      [null, true],
      [undefined, true],
    ])('payment_status %p counts as unpaid: %p', (status, expectedUnpaid) => {
      const impact = summariseClearImpact([{ payment_status: status as string | null, total: 10 }])
      expect(impact.unpaid === 1).toBe(expectedUnpaid)
      expect(impact.requiresConfirmation).toBe(expectedUnpaid)
    })
  })

  test('a non-numeric total does not poison the amount owed', () => {
    const impact = summariseClearImpact([
      { payment_status: 'pending', total: 'not-a-number' },
      { payment_status: 'pending', total: 40 },
    ])
    expect(impact.unpaid).toBe(2)
    expect(impact.unpaidTotal).toBe(40)
    expect(clearTableConfirmationMessage(impact)).not.toContain('NaN')
  })

  describe('the message', () => {
    test('names the amount owed and says it leaves the dashboard', () => {
      const msg = clearTableConfirmationMessage(
        summariseClearImpact([{ payment_status: 'pending', total: 120 }]),
      )
      expect(msg).toContain('N$120.00')
      expect(msg).toMatch(/unpaid/i)
      expect(msg).toMatch(/no longer appear on the dashboard/i)
    })

    test('an unpaid warning reads differently in kind from an all-paid one', () => {
      const paidOnly = clearTableConfirmationMessage(
        summariseClearImpact([{ payment_status: 'paid', total: 50 }]),
      )
      const withUnpaid = clearTableConfirmationMessage(
        summariseClearImpact([{ payment_status: 'pending', total: 50 }]),
      )
      expect(paidOnly).not.toMatch(/unpaid/i)
      expect(paidOnly).not.toMatch(/no longer appear/i)
      expect(withUnpaid).not.toEqual(paidOnly)
    })

    test('singular and plural both read correctly', () => {
      const one = clearTableConfirmationMessage(
        summariseClearImpact([{ payment_status: 'pending', total: 10 }]),
      )
      const two = clearTableConfirmationMessage(
        summariseClearImpact([
          { payment_status: 'pending', total: 10 },
          { payment_status: 'pending', total: 10 },
        ]),
      )
      expect(one).toContain('1 order for')
      expect(one).toContain('is UNPAID')
      expect(two).toContain('2 orders for')
      expect(two).toContain('are UNPAID')
    })
  })

  test('formatClearAmount is defensive about rubbish input', () => {
    expect(formatClearAmount(0)).toBe('N$0.00')
    expect(formatClearAmount(12.5)).toBe('N$12.50')
    expect(formatClearAmount(Number.NaN)).toBe('N$0.00')
  })
})
