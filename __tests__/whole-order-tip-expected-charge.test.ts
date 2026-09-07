/**
 * THE WHOLE-ORDER GRATUITY — the amount charged and the amount verified are the same number.
 *
 * ==================================================================================================
 * THE INVARIANT, AND WHAT BREAKING IT COST
 * ==================================================================================================
 *
 * THE AMOUNT SENT TO THE GATEWAY MUST BE THE AMOUNT VERIFICATION COMPARES AGAINST.
 *
 * The split path already held to it: an intent's amount_cents is both what the reader is told to
 * charge and what a gateway echo is reconciled against, at zero tolerance. The whole-order path did
 * not — three gates independently recomputed `order.total`:
 *
 *   app/api/terminal/orders/[orderId]/verify-payment/route.ts
 *   app/api/webhooks/paycloud/route.ts
 *   app/api/payments/reconcile/route.ts
 *
 * So adding a tip to the charge would make all three refuse a payment that SUCCEEDED, after the
 * customer's card had been debited. Which is exactly why the tip was never added to the charge, and
 * was instead recorded in payment_tips as collected while the customer paid the bill alone: a
 * silent under-charge with the ledger disagreeing with the money.
 *
 * ==================================================================================================
 * ZERO TOLERANCE IS NOT WEAKENED
 * ==================================================================================================
 *
 * There is NO tip tolerance and no band. GATEWAY_AMOUNT_TOLERANCE_CENTS stays zero, because Finatic
 * echoes back OUR OWN figure and a cent of daylight means the reference correlated to a DIFFERENT
 * SALE. The figure being compared is corrected; the comparison is not loosened. The tests below
 * assert both halves of that — the right amount passes AND every other amount still fails.
 */
import {
  EXPECTED_CHARGE_COLUMNS,
  expectedChargeFor,
  expectedChargeForOrders,
} from '@/lib/payments/expected-charge'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'

/** An order with no recorded attempt — every order predating this feature. */
const untouched = (total: number) => ({ total })

/** An order whose charge was prepared: total + tip, recorded before the reader launched. */
const prepared = (totalCents: number, tipCents: number) => ({
  total: totalCents / 100,
  pending_charge_cents: totalCents + tipCents,
  pending_tip_cents: tipCents,
})

/** What a gate does with a gateway echo: exact agreement, zero tolerance. */
const verifies = (gatewayAmount: number, row: Parameters<typeof expectedChargeFor>[0]) =>
  amountsMatch(gatewayAmount, expectedChargeFor(row).expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS)

describe('1. NO TIP — the charge equals the order total', () => {
  it('a prepared, untipped charge expects exactly the total', () => {
    expect(expectedChargeFor(prepared(3400, 0)).expectedAmount).toBe(34)
    expect(expectedChargeFor(prepared(3400, 0)).tipCents).toBe(0)
  })

  it('an order with no recorded attempt falls back to its total', () => {
    /**
     * LOAD-BEARING, not defensive. Every order placed before this existed has no recorded attempt,
     * as does every path that never prepares a charge. Without the fallback, deploying this would
     * refuse every in-flight payment in the estate.
     */
    const c = expectedChargeFor(untouched(34))
    expect(c.expectedAmount).toBe(34)
    expect(c.basis).toBe('order_total')
  })
})

describe('2. WITH A TIP — the charge equals total plus tip', () => {
  it('the expectation includes the gratuity', () => {
    const c = expectedChargeFor(prepared(3400, 500))
    expect(c.expectedAmount).toBe(39)
    expect(c.basis).toBe('recorded_attempt')
  })

  it('and it still knows how much of that was the tip', () => {
    // The settlement has to split one charged figure back into revenue and gratuity. A tip is not
    // revenue and never enters an order total.
    expect(expectedChargeFor(prepared(3400, 500)).tipCents).toBe(500)
  })
})

describe('3. the gateway returns EXACTLY total + tip — it succeeds', () => {
  it('a tipped charge verifies', () => {
    expect(verifies(39, prepared(3400, 500))).toBe(true)
  })

  it('an untipped charge still verifies — the ordinary case is unchanged', () => {
    // The positive control for the whole change. If this broke, every card payment in the estate
    // would stop verifying.
    expect(verifies(34, prepared(3400, 0))).toBe(true)
    expect(verifies(34, untouched(34))).toBe(true)
  })
})

describe('4. the gateway returns the ORDER TOTAL when a tip was expected — it FAILS', () => {
  it('34 against an expected 39 is refused', () => {
    /**
     * The precise case a "tip tolerance" would have wrongly accepted. A gateway echo of the bill
     * alone, when we asked for bill + tip, means the reference correlated to something other than
     * the charge we made — not that a tip is optional.
     */
    expect(verifies(34, prepared(3400, 500))).toBe(false)
  })
})

describe('5. any other amount FAILS — zero tolerance is intact', () => {
  it.each([
    ['one cent under', 38.99],
    ['one cent over', 39.01],
    ['the tip alone', 5],
    ['double', 78],
    ['zero', 0],
  ])('%s is refused', (_label, amount) => {
    expect(verifies(amount as number, prepared(3400, 500))).toBe(false)
  })

  it('the tolerance constant itself is still zero', () => {
    /**
     * Asserted directly. Every refusal above would also pass with a one-cent tolerance, so without
     * this the suite could not tell "exact" from "nearly exact" — and a later widening would go
     * unnoticed.
     */
    expect(GATEWAY_AMOUNT_TOLERANCE_CENTS).toBe(0)
  })
})

describe('6. a successful tipped payment preserves the accounting split', () => {
  it('the charge, the revenue and the gratuity are all recoverable from the row', () => {
    const c = expectedChargeFor(prepared(3400, 500))
    const orderCents = Math.round(c.expectedAmount * 100) - c.tipCents
    expect({ charged: Math.round(c.expectedAmount * 100), revenue: orderCents, tip: c.tipCents })
      .toEqual({ charged: 3900, revenue: 3400, tip: 500 })
  })

  it('a tip larger than the charge is not usable arithmetic and reports none', () => {
    // Rather than yielding a negative order amount downstream. The DB constraint forbids this too;
    // this is what happens if a row ever slips past it.
    const c = expectedChargeFor({ total: 34, pending_charge_cents: 100, pending_tip_cents: 500 })
    expect(c.tipCents).toBe(0)
  })
})

describe('MULTI-ORDER charges — the webhook and reconcile cases', () => {
  it('sums each order\'s own expectation', () => {
    const c = expectedChargeForOrders([prepared(3400, 500), prepared(1000, 0)])
    expect(c.expectedAmount).toBe(49)
    expect(c.tipCents).toBe(500)
  })

  it('a MIXED set — one prepared, one not — still produces one honest figure', () => {
    /**
     * Not an all-or-nothing choice between the two rules. A tab settled across orders where only
     * some were prepared must still add up, or the webhook refuses a real payment.
     */
    const c = expectedChargeForOrders([prepared(3400, 500), untouched(10)])
    expect(c.expectedAmount).toBe(49)
    expect(c.basis).toBe('recorded_attempt')
  })

  it('an all-unprepared set behaves exactly as before this change', () => {
    const c = expectedChargeForOrders([untouched(34), untouched(10)])
    expect(c.expectedAmount).toBe(44)
    expect(c.basis).toBe('order_total')
  })
})

describe('THE COLUMNS ARE SELECTED, NOT MERELY WRITTEN', () => {
  /**
   * The failure mode this project has shipped before: a route writes a column and never selects it,
   * so the fix is inert and both tsc and unit tests are blind to it.
   *
   * expectedChargeFor falls back to the order total when pending_charge_cents is absent -- which is
   * exactly what an unselected column looks like. So a gate that forgot to SELECT it would behave
   * as though no gratuity had ever been charged, silently, and every test above would still pass.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  it.each([
    ['verify-payment', 'app/api/terminal/orders/[orderId]/verify-payment/route.ts'],
    ['paycloud webhook', 'app/api/webhooks/paycloud/route.ts'],
  ])('%s selects pending_charge_cents', (_name, rel) => {
    const code = readFileSync(join(process.cwd(), rel), 'utf8')
    expect(code).toMatch(/pending_charge_cents/)
    expect(code).toMatch(/pending_tip_cents/)
  })

  it('reconcile reads whole rows, so it needs no column list', () => {
    const code = readFileSync(join(process.cwd(), 'app/api/payments/reconcile/route.ts'), 'utf8')
    expect(code).toMatch(/\.select\('\*'\)/)
  })

  it('and the helper names the columns a caller must select', () => {
    expect(EXPECTED_CHARGE_COLUMNS).toContain('pending_charge_cents')
    expect(EXPECTED_CHARGE_COLUMNS).toContain('pending_tip_cents')
  })
})

describe('NO GATE COMPARES AGAINST order.total ANY MORE', () => {
  /**
   * The regression that would silently restore the defect. Each gate previously derived its
   * expectation from the order total; if any one of them goes back, a tipped payment is refused
   * after the customer has paid -- and the five arithmetic suites above would all still pass,
   * because they test the helper rather than the call sites.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  it.each([
    ['verify-payment', 'app/api/terminal/orders/[orderId]/verify-payment/route.ts'],
    ['paycloud webhook', 'app/api/webhooks/paycloud/route.ts'],
    ['reconcile', 'app/api/payments/reconcile/route.ts'],
  ])('%s derives its expectation from the recorded charge', (_name, rel) => {
    const code = readFileSync(join(process.cwd(), rel), 'utf8')
    const statements = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(statements).toMatch(/expectedChargeFor(Orders)?\(/)
    // And not the old shape, in any of its three spellings.
    expect(statements).not.toMatch(/const expectedAmount = Number\(order\.total\)/)
    expect(statements).not.toMatch(/sum \+ \(Number\(row\.total\) \|\| 0\)/)
    expect(statements).not.toMatch(/s \+ \(Number\(r\.data\.total\) \|\| 0\)/)
  })
})
