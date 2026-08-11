/**
 * #165 — is the VAT figure on a receipt arithmetically correct?
 *
 * SCOPE: arithmetic only. #165's own subject is PRESENTATION — a receipt showing an inc-VAT unit
 * price beside an ex-VAT line total — and a copy decision on that is pending. Nothing here
 * changes, proposes or depends on any receipt wording. What is settled below is the narrower
 * question underneath it: whether the numbers are right, under both tax configurations, with
 * quantities, and once several lines are summed into the figure the customer reads as "VAT".
 *
 * WHERE THE RECEIPT'S VAT ACTUALLY COMES FROM, since it is not obvious:
 *   lib/receipts/issueReceipt.ts:268   `const vat = Number(order.tax) || 0`
 * The receipt does NOT compute VAT. It freezes `orders.tax`, which was written at order time by
 * lib/orders/calculate-order-pricing.ts:201 as the sum of per-line taxes, each produced by
 * applyTaxToAmount. So the arithmetic under test is applyTaxToAmount plus that aggregation, and
 * every renderer (sdk6, ESC/POS, HTML, PDF) reads the same frozen snapshot.
 *
 * TWO CONFIGURATIONS THAT DO NOT EXIST, established by reading rather than assumed:
 *   - SERVICE CHARGE. `restaurants.service_charge numeric(5,2) NOT NULL DEFAULT 0` exists
 *     (baseline.sql:544) and the admin settings route reads and writes it, but NOTHING consumes
 *     it. No pricing, order or receipt module references it. So "with a service charge present"
 *     is not a reachable state: it can be configured and is never applied, and it cannot
 *     currently affect a VAT figure.
 *   - A TAB-LEVEL RECEIPT. There is no such thing. Settling a tab calls
 *     safeIssueReceiptsForOrders (tabs/[tabId]/settle/route.ts:368) — plural — which issues one
 *     receipt PER ORDER. A tab of several orders produces several receipts, each with its own
 *     VAT computed from its own order. There is no combined VAT figure that could be wrong.
 */
import { applyTaxToAmount, round2 } from '@/lib/tax-rates/apply-tax'
import type { TaxRateOption } from '@/lib/tax-rates/format'

const INCLUSIVE: TaxRateOption = {
  id: 'inc', name: 'VAT', percentage: 15, is_inclusive: true, is_default: true,
}
const EXCLUSIVE: TaxRateOption = {
  id: 'exc', name: 'VAT', percentage: 15, is_inclusive: false, is_default: false,
}
const ZERO: TaxRateOption = {
  id: 'zero', name: 'Zero-rated', percentage: 0, is_inclusive: true, is_default: false,
}

/** What calculate-order-pricing.ts:200-202 does: sum the per-line rounded figures. */
function orderTotals(lineAmounts: number[], rate: TaxRateOption | null) {
  const lines = lineAmounts.map((a) => applyTaxToAmount(a, rate))
  return {
    subtotal: round2(lines.reduce((s, l) => s + l.subtotal, 0)),
    tax: round2(lines.reduce((s, l) => s + l.tax, 0)),
    total: round2(lines.reduce((s, l) => s + l.total, 0)),
  }
}

/**
 * The rate is per-restaurant configurable (lib/tax-rates), so 15% is a local default and not a
 * constant. Sweeping several percentages is not padding: the identity below is INDEPENDENT of
 * the rate under the current implementation and RATE-DEPENDENT under a plausible refactor of it
 * — see the "derived by subtraction" test at the end for the case that proves it.
 */
const RATES: Array<[number, boolean]> = [
  [15, true], [15, false], [20, true], [20, false],
  [14, true], [12.5, true], [7.5, true], [5, true], [17.5, true], [0, true],
]

function rateOf(percentage: number, is_inclusive: boolean): TaxRateOption {
  return { id: `r${percentage}${is_inclusive}`, name: 'VAT', percentage, is_inclusive, is_default: false }
}

describe('#165 — the identity the receipt is read against', () => {
  // Subtotal + VAT = Total is the only arithmetic claim a receipt makes on its face. If it ever
  // fails the customer is looking at a provably wrong document, whatever the VAT basis is.
  it.each(RATES)('holds for every cent from 0.01 to 500.00 at %s%% (inclusive=%s)', (pct, inc) => {
    const rate = rateOf(pct, inc)
    const failures: string[] = []
    for (let cents = 1; cents <= 50_000; cents++) {
      const { subtotal, tax, total } = applyTaxToAmount(cents / 100, rate)
      if (round2(subtotal + tax) !== total) failures.push(`${cents / 100}`)
    }
    expect(failures.slice(0, 5)).toEqual([])
  })

  it('holds after several lines are summed into one order', () => {
    const failures: string[] = []
    for (let trial = 0; trial < 5_000; trial++) {
      const n = 1 + (trial % 8)
      const amounts = Array.from({ length: n }, (_, k) => (((trial * 7 + k * 13) % 5_000) + 1) / 100)
      for (const rate of [INCLUSIVE, EXCLUSIVE]) {
        const o = orderTotals(amounts, rate)
        if (round2(o.subtotal + o.tax) !== o.total) {
          failures.push(`${rate.id} ${JSON.stringify(amounts)}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})

describe('#165 — an inclusive rate never changes what is charged', () => {
  // The defining property of an inclusive rate: VAT is backed OUT of the menu price, never added
  // to it. If this drifts, every customer is charged something other than the price they agreed.
  it('leaves the charged total equal to the menu amount', () => {
    const failures: string[] = []
    for (let cents = 1; cents <= 50_000; cents++) {
      const amount = cents / 100
      if (applyTaxToAmount(amount, INCLUSIVE).total !== round2(amount)) failures.push(`${amount}`)
    }
    expect(failures).toEqual([])
  })

  it('adds VAT on top for an exclusive rate, and only then', () => {
    const e = applyTaxToAmount(100, EXCLUSIVE)
    expect(e.subtotal).toBe(100)
    expect(e.tax).toBe(15)
    expect(e.total).toBe(115)

    const i = applyTaxToAmount(100, INCLUSIVE)
    expect(i.total).toBe(100)
    expect(i.tax).toBe(13.04)
    expect(i.subtotal).toBe(86.96)
  })

  it('charges the raw amount with no tax when there is no rate, or a zero rate', () => {
    for (const rate of [null, ZERO]) {
      const r = applyTaxToAmount(42.42, rate)
      expect(r.tax).toBe(0)
      expect(r.subtotal).toBe(42.42)
      expect(r.total).toBe(42.42)
    }
  })
})

describe('#165 — quantity', () => {
  /*
   * VAT is computed on the WHOLE line (quantity x unit price) in one go —
   * calculate-order-pricing.ts:116 passes `unitPrice * quantity` to applyTaxToAmount. The
   * alternative, taxing one unit and multiplying, is a real and different answer, so this is a
   * choice rather than an accident and it is worth pinning.
   */
  it('taxes the whole line, which is NOT the same as taxing one unit and multiplying', () => {
    // 7 x 0.07: per-unit VAT rounds to 0.01 and multiplies to 0.07; the line is 0.49 and its
    // VAT is 0.06. A cent of difference, in the customer's favour or not depending on the case.
    const line = applyTaxToAmount(0.07 * 7, INCLUSIVE)
    const perUnitTimesQty = round2(applyTaxToAmount(0.07, INCLUSIVE).tax * 7)

    expect(line.tax).toBe(0.06)
    expect(perUnitTimesQty).toBe(0.07)
    expect(line.tax).not.toBe(perUnitTimesQty)
  })

  it('is stable for ordinary quantities', () => {
    const three = applyTaxToAmount(25 * 3, INCLUSIVE)
    expect(three.total).toBe(75)
    expect(round2(three.subtotal + three.tax)).toBe(75)
  })
})

describe('#165 — the receipt from the issue reproduces exactly', () => {
  // The physical receipt printed from the Finatic-UAT P5 on 2026-08-05. Reproducing it from the
  // real function is what makes "the arithmetic is internally consistent" a checked claim rather
  // than a reported one.
  it('produces the printed subtotal, VAT and total', () => {
    const burger = applyTaxToAmount(25.0, INCLUSIVE)
    const coke = applyTaxToAmount(15.56, INCLUSIVE)

    expect(burger.subtotal).toBe(21.74)
    expect(coke.subtotal).toBe(13.53)

    const order = orderTotals([25.0, 15.56], INCLUSIVE)
    expect(order.subtotal).toBe(35.27)
    expect(order.tax).toBe(5.29)
    expect(order.total).toBe(40.56)
  })
})

describe('#165 — per-line VAT rounding, characterised so it is not mistaken for a defect', () => {
  /*
   * Summing per-line VAT is NOT always equal to computing VAT once on the order total. That is
   * inherent to rounding each line to a cent and is the normal convention; it is recorded here
   * so nobody "corrects" it later. Correcting it would change `orders.tax` and therefore what a
   * VAT-registered merchant reports, which is a money decision and not an engineering one.
   *
   * What matters for the receipt is that subtotal + VAT = total, which is asserted above and
   * holds in every case. The customer is charged the same total either way.
   */
  it('can differ from single-shot VAT, by at most one cent per line', () => {
    // Six small lines: per-line VAT sums to 0.53 where a single computation gives 0.54.
    const amounts = [0.36, 0.49, 0.62, 0.75, 0.88, 1.01]
    const perLine = orderTotals(amounts, INCLUSIVE)
    const singleShot = applyTaxToAmount(perLine.total, INCLUSIVE)

    expect(perLine.tax).toBe(0.53)
    expect(singleShot.tax).toBe(0.54)

    // Bounded, and the identity still holds — which is the property the receipt depends on.
    expect(Math.abs(round2(singleShot.tax - perLine.tax))).toBeLessThanOrEqual(0.01 * amounts.length)
    expect(round2(perLine.subtotal + perLine.tax)).toBe(perLine.total)
  })
})

describe('#165 — the inclusive subtotal must be derived BY SUBTRACTION', () => {
  /*
   * apply-tax.ts computes the inclusive branch as:
   *
   *   total    = round2(amount)
   *   tax      = round2(total - total / (1 + p/100))
   *   subtotal = round2(total - tax)          <-- BY SUBTRACTION
   *
   * The last line looks interchangeable with the algebraically equal
   * `round2(total / (1 + p/100))`, and at 15% it IS: zero divergences across 0.01..2000.00. At
   * 20% that same substitution diverges 11,033 times in the same range, because subtotal and tax
   * can then BOTH round up and their sum overshoots the total by a cent — breaking the one
   * identity the receipt asserts on its face.
   *
   * Deriving by subtraction cannot do that, at any rate: `total` and `tax` are already whole
   * cents, so `total - tax` is exact and round2 is the identity on it. That is what makes the
   * property rate-independent, and it is why this is a correctness constraint rather than a
   * style preference.
   *
   * This test exists because the sweep above passed the substitution when it only covered 15%.
   * The rate is per-restaurant configurable, so covering one rate was not enough.
   */
  it('keeps subtotal + tax === total at 20%, where the direct-division form does not', () => {
    const rate = rateOf(20, true)

    // The three smallest cases where the two formulations disagree.
    for (const total of [0.03, 0.09, 0.15]) {
      const { subtotal, tax } = applyTaxToAmount(total, rate)
      expect(round2(subtotal + tax)).toBe(total)

      // What the direct-division form would have produced, computed inline so the divergence is
      // visible rather than asserted from memory.
      const byDivision = round2(total / 1.2)
      expect(round2(byDivision + tax)).not.toBe(total)
    }
  })
})

describe('#165 — sub-cent unit prices (current behaviour, pinned NOT endorsed)', () => {
  /*
   * SEPARATE FINDING, recorded rather than fixed.
   *
   * calculate-order-pricing.ts stores `unitPrice: round2(unitPrice)` but computes the line from
   * the RAW unit price (`applyTaxToAmount(unitPrice * quantity, rate)`, :116). When a unit price
   * carries more than two decimals the two disagree, and a receipt then shows a unit price which
   * does not multiply to its own line total — arithmetically visible to the customer, and a
   * different complaint from the one #165 reports.
   *
   * Reachable, not theoretical: `menu_items.base_price` is `numeric` with NO scale
   * (baseline.sql:387), sizes/addons prices live in unconstrained jsonb, and
   * app/api/admin/menu/items/route.ts spreads the raw request body into buildMenuItemDbPayload,
   * which does `Number(data.base_price)` with no rounding. `step="0.01"` in the form is a browser
   * hint, not a server constraint.
   *
   * NOT FIXED HERE. Rounding the unit price before multiplying would change the amount charged;
   * rounding after keeps the charge and moves the display. That is a money decision. This test
   * pins today's answer so a change to it is deliberate and visible.
   */
  it('computes the line from the unrounded unit price, so display x quantity can disagree', () => {
    const rawUnit = 10.005
    const quantity = 4

    const line = applyTaxToAmount(rawUnit * quantity, INCLUSIVE)
    const displayedUnit = round2(rawUnit)

    expect(displayedUnit).toBe(10.01)
    expect(line.total).toBe(40.02)
    // What a customer checking the receipt would compute:
    expect(round2(displayedUnit * quantity)).toBe(40.04)
    expect(round2(displayedUnit * quantity)).not.toBe(line.total)
  })
})
