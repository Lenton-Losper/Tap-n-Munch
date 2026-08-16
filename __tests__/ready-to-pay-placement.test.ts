/**
 * Binds to lib/tabs/ready-to-pay-placement.ts.
 *
 * THE TWO TESTS THAT MATTER PULL IN OPPOSITE DIRECTIONS, and that is the point:
 *
 *   `suppresses the per-order control on a tab` — spec section 30. On a tab there are two
 *   different "call the waiter" mechanisms writing to two different tables with nothing
 *   reconciling them (audit D8), and the terminal reads the tab.
 *
 *   `keeps it for an order with no tab` — an order off a tab has no tab to settle from, so this
 *   button is the ONLY way that customer can tell staff anything. A change that removed it
 *   everywhere would be tidier and would strand them.
 *
 * A rule that only ever said "no" would pass the first and fail the second, which is why both
 * are here rather than one.
 */
import {
  orderIsOnATab,
  perOrderReadyToPayAllowed,
} from '@/lib/tabs/ready-to-pay-placement'

describe('perOrderReadyToPayAllowed', () => {
  it('suppresses the per-order control on a tab — the Tab owns settlement', () => {
    expect(perOrderReadyToPayAllowed({ tab_id: '11111111-2222-3333-4444-555555555555' })).toBe(false)
  })

  it('keeps it for an order with no tab, which has nowhere else to ask', () => {
    expect(perOrderReadyToPayAllowed({ tab_id: null })).toBe(true)
    expect(perOrderReadyToPayAllowed({})).toBe(true)
  })

  it('treats an empty or whitespace tab id as no tab', () => {
    // PostgREST returns '' for some empty text columns; a blank string is not a tab.
    expect(perOrderReadyToPayAllowed({ tab_id: '' })).toBe(true)
    expect(perOrderReadyToPayAllowed({ tab_id: '   ' })).toBe(true)
  })

  it('shows the control rather than hiding it when the row is missing entirely', () => {
    // Deliberate direction. Being wrong this way costs a duplicate signal; being wrong the other
    // way costs a customer who cannot ask to pay at all.
    expect(perOrderReadyToPayAllowed(null)).toBe(true)
    expect(perOrderReadyToPayAllowed(undefined)).toBe(true)
  })

  it('orderIsOnATab is the same decision, inverted', () => {
    for (const row of [{ tab_id: 'x' }, { tab_id: null }, {}, { tab_id: '' }]) {
      expect(orderIsOnATab(row)).toBe(!perOrderReadyToPayAllowed(row))
    }
  })
})
