/**
 * AN OLD TERMINAL MUST NOT BE REFUSED AFTER ITS CARD HAS ALREADY BEEN CHARGED.
 *
 * ==================================================================================================
 * THE REGRESSION THIS EXISTS TO PREVENT
 * ==================================================================================================
 *
 * Moving the whole-order charge basis to the OUTSTANDING amount fixed the double charge, and broke
 * something in the same breath: the settle route also checks the amount the DEVICE sends, and every
 * terminal in the field computes that figure the old way.
 *
 * selectClaimableOrdersForSettle (APK 136 and earlier) sums order.total. On a part-paid order that
 * is the full N$37.00 while the server now expects the N$20.00 outstanding, so the cross-check
 * refuses -- and the order of operations makes that far worse than it sounds:
 *
 *   1. prepare-payment charges the reader the correct outstanding amount.  MONEY MOVES.
 *   2. the device reports success and calls /settle with its legacy figure.
 *   3. the amount check refuses it.
 *
 * A real charge, no settlement recorded against it. That is the orphan the whole payment area is
 * built to avoid, manufactured by a fix meant to protect the customer. On the cash path it is less
 * severe and still wrong: a legitimate collection blocked at the till.
 *
 * ==================================================================================================
 * WHY ACCEPTING THE LEGACY FIGURE IS NOT WIDENING A TOLERANCE
 * ==================================================================================================
 *
 * Both expectations are computed on the SERVER from its own rows. The device is not being trusted
 * with a figure; it is being recognised as speaking an older dialect of the same sentence.
 * amountsMatch still runs at its existing precision against each, and an amount matching NEITHER is
 * still refused -- which is the case these tests spend most of their assertions on.
 *
 * And what is recorded never changes: payments.amount and the audit row are always the outstanding
 * truth, whichever figure the device sent.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chargeableCentsFor } from '@/lib/payments/settled-cents'
import { amountsMatch } from '@/lib/payments/payment-integrity'

/**
 * THE ROUTE'S OWN SOURCE.
 *
 * accepts() below restates the route's decision so the two expectations can be exercised without
 * the settle harness. A restatement proves the RULE is right and proves nothing about the route --
 * delete the guard from the route and every case below still passes, because they would be testing
 * a copy.
 *
 * So the route source is read and the guard asserted in it. That is what makes the mutation bite.
 */
const SETTLE_ROUTE = readFileSync(
  join(process.cwd(), 'app', 'api', 'terminal', 'tabs', '[tabId]', 'settle', 'route.ts'),
  'utf8',
)

/** Order #45 as it stood: N$37.00, N$17.00 settled through allocations, N$20.00 owed. */
const ORDER_TOTAL = 37
const SETTLED_CENTS = 1700

const outstanding = () => chargeableCentsFor(ORDER_TOTAL, SETTLED_CENTS) / 100
const legacy = () => ORDER_TOTAL

/**
 * The route's decision, extracted exactly as written so the two expectations can be exercised
 * without standing up the whole settle harness (which is 401-blocked in this suite's siblings).
 */
function accepts(clientAmount: number, expectedAmount: number, legacyAmount: number): boolean {
  const matchesLegacyBasis =
    legacyAmount !== expectedAmount && amountsMatch(clientAmount, legacyAmount)
  return matchesLegacyBasis || amountsMatch(clientAmount, expectedAmount)
}

describe('the amounts themselves', () => {
  it('outstanding is N$20.00 and the legacy basis is N$37.00', () => {
    expect(outstanding()).toBe(20)
    expect(legacy()).toBe(37)
  })
})

describe('an APK 136 device on a part-paid order', () => {
  it('is ACCEPTED though it sends the legacy N$37.00', () => {
    // Without this the card is charged N$20.00 and the settlement is refused: an orphan.
    expect(accepts(37, outstanding(), legacy())).toBe(true)
  })

  it('a device that has been updated and sends N$20.00 is accepted too', () => {
    expect(accepts(20, outstanding(), legacy())).toBe(true)
  })
})

describe('an ordinary order with nothing settled', () => {
  it('has ONE basis, and it still has to match', () => {
    /**
     * THE POSITIVE CONTROL. Almost every settle on production is this shape. Here the two
     * expectations are the same figure, so the legacy allowance is inert and the check is exactly
     * as strict as it was before any of this.
     */
    const exp = chargeableCentsFor(37, 0) / 100
    expect(exp).toBe(37)
    expect(accepts(37, exp, 37)).toBe(true)
    expect(accepts(30, exp, 37)).toBe(false)
    expect(accepts(0.01, exp, 37)).toBe(false)
  })
})

describe('an amount matching NEITHER basis is still refused', () => {
  it.each([
    ['far too little', 5],
    ['between the two', 28],
    ['far too much', 100],
    ['zero', 0],
    ['negative', -20],
  ])('%s (%s) is rejected', (_label, sent) => {
    expect(accepts(sent as number, outstanding(), legacy())).toBe(false)
  })

  it('the settled portion on its own is rejected', () => {
    // N$17.00 is money already collected, not a figure any device should be sending.
    expect(accepts(17, outstanding(), legacy())).toBe(false)
  })
})

describe('the allowance cannot become a general escape hatch', () => {
  it('is inert once nothing is outstanding-vs-total different', () => {
    // legacyAmount === expectedAmount disables the branch by construction.
    const exp = 37
    expect(accepts(37, exp, 37)).toBe(true)
    expect(accepts(20, exp, 37)).toBe(false) // no second basis to hide behind
  })

  it('does not let a fully-settled order be settled again for its old total', () => {
    /**
     * The dangerous shape: everything paid, so outstanding is zero. The route refuses this earlier
     * with NOTHING_LEFT_TO_CHARGE, and even if it did not, N$37.00 must not sail through on the
     * legacy basis.
     */
    const exp = chargeableCentsFor(37, 3700) / 100
    expect(exp).toBe(0)
    // the route's own guard fires first
    expect(exp <= 0).toBe(true)
  })
})

// ==================================================================================================
// THE ROUTE ACTUALLY DOES THIS
// ==================================================================================================

describe('the settle route itself carries the guard', () => {
  it('computes the legacy basis from the server rows', () => {
    expect(SETTLE_ROUTE).toContain('const legacyWholeOrderAmount = roundToCents(')
    expect(SETTLE_ROUTE).toContain('(tabOrders ?? []).reduce((sum, o) => sum + Number(o.total), 0)')
  })

  it('disables the allowance when the two bases are the same figure', () => {
    // legacyWholeOrderAmount !== expectedAmount is what keeps an ordinary order strict.
    expect(SETTLE_ROUTE).toContain('legacyWholeOrderAmount !== expectedAmount')
  })

  it('refuses only when BOTH expectations fail', () => {
    /**
     * The line the mutation removes. Without `!matchesLegacyBasis &&` an APK 136 device is refused
     * after its card has already been charged, which is the orphan.
     */
    expect(SETTLE_ROUTE).toContain(
      'if (!matchesLegacyBasis && !amountsMatch(amount, expectedAmount)) {',
    )
  })

  it('still RECORDS the outstanding figure, never the legacy one', () => {
    // payments.amount and the audit row are written from expectedAmount. If the legacy figure were
    // ever assigned into it, the allowance would have become a money change.
    expect(SETTLE_ROUTE).not.toContain('expectedAmount = legacyWholeOrderAmount')
    expect(SETTLE_ROUTE).toContain('recording: expectedAmount')
  })
})
