/**
 * TWO DEFECTS A PHYSICAL P5 FOUND THAT EVERY AUTOMATED TEST MISSED — 2026-09-09, Digi Cofee.
 *
 * ==================================================================================================
 * WHY THE SUITES WERE GREEN
 * ==================================================================================================
 *
 * Both defects sat in places nothing was asserting AT ALL, rather than in code a test got wrong:
 *
 *   the outstanding total   `unpaid_total` summed whole unpaid ORDERS. Correct while settlement was
 *                           order-grained; wrong from the moment items could be paid individually.
 *                           No test computed it against a part-paid order, because none existed
 *                           when it was written.
 *
 *   the settings switch     PayToday reached the DB CHECK, the API allowlist and the terminal. The
 *                           settings screen has two HARDCODED switches and a two-value union, so
 *                           there was no way to turn it on — and nothing tested the screen's method
 *                           list, so nothing noticed.
 *
 * Neither is a subtle race. Both are "nobody looked", which is what a device found in ten minutes.
 */
import { outstandingCentsFor, outstandingTotalFor } from '@/lib/tabs/outstanding-total'

describe('THE OUTSTANDING TOTAL EXCLUDES ITEMS ALREADY PAID FOR', () => {
  /** The tab from the P5: N$34 across one order. */
  const tab = (settledCents: number) => [{ id: 'o1', total: 34, settledCents }]

  it('34 total → pay 6 → outstanding = 28', () => {
    // The exact case observed: the N$6 cheese toast paid by card through the item path, and the
    // header went on reading NAD 34.00.
    expect(outstandingTotalFor(tab(600))).toBe(28)
  })

  it('34 → pay 20 → outstanding = 14', () => {
    expect(outstandingTotalFor(tab(2000))).toBe(14)
  })

  it('34 → pay 34 → outstanding = 0', () => {
    expect(outstandingTotalFor(tab(3400))).toBe(0)
  })

  it('nothing settled → the full total, exactly as before', () => {
    /**
     * THE POSITIVE CONTROL. Every case above subtracts something; if the function simply returned
     * zero, or dropped orders, they would all still pass. This is the ordinary tab.
     */
    expect(outstandingTotalFor(tab(0))).toBe(34)
    expect(outstandingTotalFor([{ id: 'o1', total: 34 }])).toBe(34)
  })

  it('an over-settled order cannot drive the tab negative', () => {
    // A negative headline is a worse lie than a stale one.
    expect(outstandingTotalFor(tab(9999))).toBe(0)
  })

  it('one over-settled order cannot absorb ANOTHER order\'s genuine debt', () => {
    /**
     * The reason the clamp is PER ORDER rather than on the sum. Clamping only at the end would let
     * an over-settled order cancel out real money owed elsewhere on the tab — reporting less owed
     * than there is, which is the direction that loses money.
     */
    const orders = [
      { id: 'over', total: 10, settledCents: 5000 },
      { id: 'owed', total: 20, settledCents: 0 },
    ]
    expect(outstandingTotalFor(orders)).toBe(20)
  })

  it('works in integer cents, so a repeating fraction cannot drift the headline', () => {
    // 3 x 0.10 must be 30c, not 30.000000000000004c.
    expect(outstandingCentsFor([
      { id: 'a', total: 0.1 },
      { id: 'b', total: 0.1 },
      { id: 'c', total: 0.1 },
    ])).toBe(30)
  })

  it('a missing or unparseable settled figure subtracts nothing', () => {
    /**
     * FAILS TOWARDS THE OLD BEHAVIOUR. If the settlements read fails, the map is empty and the
     * headline is the pre-fix figure: stale, but never UNDERSTATED. Reporting a tab as owing less
     * than it does is the failure that costs money.
     */
    expect(outstandingTotalFor([{ id: 'a', total: 34, settledCents: NaN }])).toBe(34)
    expect(outstandingTotalFor([{ id: 'a', total: 34, settledCents: -100 }])).toBe(34)
  })

  it('an empty tab owes nothing', () => {
    expect(outstandingTotalFor([])).toBe(0)
  })
})

describe('THE ROUTE ACTUALLY USES IT, AND LOADS WHAT IT NEEDS', () => {
  /**
   * The arithmetic above is worthless if the route still sums order totals. Asserted against source
   * because the handler cannot be imported under ts-jest (jose is ESM-only), and because the
   * question is static: does the route subtract settled items at all?
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')
  const CODE = readFileSync(join(process.cwd(), 'app/api/terminal/tables/route.ts'), 'utf8')
  const statements = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('the route was read — not an empty match', () => {
    expect(CODE.length).toBeGreaterThan(1000)
  })

  it('unpaid_total is derived from outstandingTotalFor', () => {
    expect(statements).toMatch(/outstandingTotalFor\(/)
  })

  it('and NOT from a bare sum of order totals', () => {
    // The exact shape that shipped. If it comes back, every arithmetic case above still passes.
    expect(statements).not.toMatch(/unpaidOrders\.reduce\(\s*\(sum: number, o: any\) => sum \+ Number\(o\.total\), 0\s*\)/)
  })

  it('it loads settled allocations to subtract', () => {
    expect(statements).toMatch(/order_line_allocation_settlements/)
    expect(statements).toMatch(/settledByOrder/)
  })
})

describe('PAYTODAY IS CONFIGURABLE IN SETTINGS, AND OFF BY DEFAULT', () => {
  /**
   * The screen is a client component with a Switch per method. Asserted against source: importing
   * it would need a DOM and a fetch harness to answer a question that is textual — is there a
   * PayToday control, is it bound to the same list, and is the kiosk section untouched?
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')
  const UI = readFileSync(join(process.cwd(), 'components/settings/settings-payment-tab.tsx'), 'utf8')
  const API = readFileSync(
    join(process.cwd(), 'app/api/admin/restaurants/[id]/settings/route.ts'),
    'utf8',
  )

  it('the files were read — not empty matches', () => {
    expect(UI.length).toBeGreaterThan(1000)
    expect(API.length).toBeGreaterThan(500)
  })

  it('PayToday is available as a configurable restaurant payment method', () => {
    expect(UI).toMatch(/payment-method-paytoday/)
    expect(UI).toMatch(/handlePaymentMethodToggle\('paytoday'/)
  })

  it('the toggle is bound to the SAME payment_methods list as cash and card', () => {
    /**
     * Not a separate piece of state. A switch wired to its own flag would render, toggle, and
     * persist nothing — which is the shape of every "it looked like it worked" defect.
     */
    expect(UI).toMatch(/checked=\{paymentMethods\.includes\('paytoday'\)\}/)
  })

  it('DEFAULT IS OFF — nothing enables it', () => {
    /**
     * The client default is ['cash','card'] and the server falls back to the same, so
     * includes('paytoday') is false for every venue that has not opted in — including Chownow
     * Nedbank, which has NO restaurant_settings row at all and runs on that fallback.
     */
    expect(UI).toMatch(/useState<string\[\]>\(\['cash', 'card'\]\)/)
    expect(UI).not.toMatch(/\['cash', 'card', 'paytoday'\]/)
  })

  it('enabling it persists paytoday, and disabling it removes it', () => {
    /**
     * The toggle builds the next list and PATCHes payment_methods; the API accepts paytoday. Both
     * halves asserted, because a UI that sends a value the API rejects is a switch that flips back.
     */
    expect(UI).toMatch(/body: JSON\.stringify\(\{ payment_methods: nextMethods \}\)/)
    expect(API).toMatch(/'paytoday'/)
    expect(API).toMatch(/VALID_PAYMENT_METHODS/)
  })

  it('KIOSK METHODS ARE UNCHANGED — PayToday is terminal-only in v1', () => {
    /**
     * Owner's ruling. The kiosk list is its own constant with its own DB CHECK
     * (cash|card|other), and neither is widened.
     */
    expect(UI).toMatch(/kioskMethods/)
    expect(UI).not.toMatch(/handleKioskMethodToggle\('paytoday'/)
    expect(UI).not.toMatch(/kiosk-payment-method-paytoday/)
    expect(API).toMatch(/const VALID_KIOSK_METHODS = \['cash', 'card', 'other'\]/)
  })

  it('the API no longer accepts the value the database rejects', () => {
    // 'online' passed this route and then violated the CHECK, so an admin got a 500 rather than a
    // 400 naming the problem. It was never valid anywhere in the schema.
    expect(API).not.toMatch(/\['cash', 'card', 'online'\]/)
  })
})
