/**
 * THE SALE ROUTE COMPARES ITS AMOUNT TO SOMETHING.
 *
 * ================================================================================================
 * THE DEFECT
 * ================================================================================================
 *
 * POST /api/terminal/payment-events/sale validated that `order_ids` existed and belonged to the
 * restaurant, and that `amount > 0`, and then compared that amount to NOTHING. One figure, N
 * orders, no check. A card charged for the wrong amount was recorded as faithfully as a correct
 * one.
 *
 * ================================================================================================
 * WHY THE OBVIOUS FIX WOULD HAVE BEEN A NEW DEFECT
 * ================================================================================================
 *
 * Comparing the amount to the sum of the named orders' totals is legitimately wrong for a
 * settlement: a payment_events row is per-SETTLE, never per-order, and may be partial, may carry a
 * gratuity deliberately outside the order total, and may cover several orders. Enforcing that
 * equality would manufacture mismatches on correct payments.
 *
 * An intent records what the READER WAS ASKED TO CHARGE. That is the honest comparison, and the
 * distinction between the two bases is what these tests are mostly about.
 */
import {
  checkSaleAmount,
  saleAmountMismatchAudit,
  SALE_AMOUNT_MISMATCH_ACTION,
} from '@/lib/payments/reconcile-sale-amount'

describe('when the charge has an intent', () => {
  it('matches the amount the reader was asked for', () => {
    const check = checkSaleAmount({ amount: 47.5, intent: { amountCents: 4750 } })
    expect(check.basis).toBe('intent')
    expect(check.matched).toBe(true)
    expect(check.expectedAmount).toBe(47.5)
  })

  it('catches a charge for a DIFFERENT amount', () => {
    // The whole point: the reader charged something other than the figure it was handed.
    const check = checkSaleAmount({ amount: 57.5, intent: { amountCents: 4750 } })
    expect(check.matched).toBe(false)
    expect(check.gatewayAmount).toBe(57.5)
    expect(check.expectedAmount).toBe(47.5)
  })

  it('catches a ONE CENT difference — a gateway echo gets no tolerance', () => {
    /**
     * GATEWAY_AMOUNT_TOLERANCE_CENTS is 0, and that is right here: this is the gateway repeating a
     * figure WE chose and handed over. There is no rounding step between the two for a cent to hide
     * in, unlike a client proposing an amount before a checkout is created.
     */
    expect(checkSaleAmount({ amount: 47.51, intent: { amountCents: 4750 } }).matched).toBe(false)
    expect(checkSaleAmount({ amount: 47.49, intent: { amountCents: 4750 } }).matched).toBe(false)
  })

  it('is NOT advisory — an intent mismatch always wants a human', () => {
    const check = checkSaleAmount({ amount: 57.5, intent: { amountCents: 4750 } })
    expect(check.advisory).toBe(false)
  })

  it('prefers the intent even when order totals are also available', () => {
    /**
     * A split payment names orders whose totals it deliberately does NOT equal — that is what a
     * part-order payment IS. Falling back to totals here would flag every correct split charge.
     */
    const check = checkSaleAmount({
      amount: 47.5,
      intent: { amountCents: 4750 },
      orderTotals: [120, 80],
    })
    expect(check.basis).toBe('intent')
    expect(check.matched).toBe(true)
  })
})

describe('when there is no intent — the whole-order path, untouched', () => {
  it('falls back to the sum of the named orders', () => {
    const check = checkSaleAmount({ amount: 200, orderTotals: [120, 80] })
    expect(check.basis).toBe('order_totals')
    expect(check.expectedAmount).toBe(200)
    expect(check.matched).toBe(true)
  })

  it('notices a settlement that does not add up', () => {
    const check = checkSaleAmount({ amount: 150, orderTotals: [120, 80] })
    expect(check.matched).toBe(false)
    expect(check.expectedAmount).toBe(200)
  })

  it('but marks it ADVISORY, because it may be perfectly correct', () => {
    /**
     * Partial payments, gratuities outside the order total, multi-order settles. A mismatch here is
     * worth saying and is not evidence of a fault — which is exactly why this could not simply be
     * enforced.
     */
    const check = checkSaleAmount({ amount: 150, orderTotals: [120, 80] })
    expect(check.advisory).toBe(true)
  })

  it('claims nothing when there is nothing to compare against', () => {
    // Silence, not a false pass dressed as a check.
    const check = checkSaleAmount({ amount: 40, orderTotals: [] })
    expect(check.basis).toBe('none')
    expect(check.expectedAmount).toBeNull()
    expect(check.matched).toBe(true)
    expect(check.advisory).toBe(true)
  })
})

describe('the two bases are never confused', () => {
  it('an intent mismatch and a totals mismatch are distinguishable', () => {
    /**
     * The reason `basis` is carried rather than a bare boolean. One means "the reader charged the
     * wrong amount"; the other means "this settlement is not the whole bill", which is ordinary.
     * Reporting them the same way would make the real one invisible among the noise.
     */
    const fromIntent = checkSaleAmount({ amount: 57.5, intent: { amountCents: 4750 } })
    const fromTotals = checkSaleAmount({ amount: 150, orderTotals: [120, 80] })

    expect(fromIntent.matched).toBe(false)
    expect(fromTotals.matched).toBe(false)
    expect(fromIntent.advisory).not.toBe(fromTotals.advisory)
    expect(fromIntent.basis).not.toBe(fromTotals.basis)
  })
})

describe('what a mismatch records', () => {
  const check = checkSaleAmount({ amount: 57.5, intent: { amountCents: 4750 } })
  const row = saleAmountMismatchAudit({
    restaurantId: 'r1',
    orderId: 'o1',
    businessOrderNo: 'FT-1',
    check,
  })

  it('names BOTH figures, and whose each is', () => {
    // #238/#268: a field called `clientAmount` once held the order's own total at four of six call
    // sites. Names that say whose figure it is are the fix for that class.
    expect(row.metadata.gatewayAmount).toBe(57.5)
    expect(row.metadata.expectedAmount).toBe(47.5)
    expect(row.metadata.expectedFrom).toBe('intent')
  })

  it('is findable from the order, under a searchable action', () => {
    expect(row.action).toBe(SALE_AMOUNT_MISMATCH_ACTION)
    expect(row.entity_type).toBe('order')
    expect(row.entity_id).toBe('o1')
  })

  it('says the payment IS recorded, so nobody re-charges the customer', () => {
    /**
     * The single most important sentence in the row. Somebody reading a mismatch at 11pm must not
     * conclude the payment failed and take it again.
     */
    expect(String(row.metadata.note)).toMatch(/payment IS recorded/i)
  })

  it('an advisory mismatch says so, and explains why it may be fine', () => {
    const advisory = saleAmountMismatchAudit({
      restaurantId: 'r1',
      orderId: 'o1',
      businessOrderNo: 'FT-1',
      check: checkSaleAmount({ amount: 150, orderTotals: [120, 80] }),
    })
    expect(advisory.metadata.advisory).toBe(true)
    expect(String(advisory.metadata.note)).toMatch(/gratuity|partial|multi-order/i)
  })
})

describe('the route records regardless — it runs after the money moved', () => {
  it('the checker never signals a refusal', () => {
    /**
     * Asserted over the SHAPE, because the tempting change is to make a bad amount a 400. Refusing
     * to record a real charge leaves a customer charged and the system unaware, which is strictly
     * worse than a flagged row. There is nothing here for a caller to reject on.
     */
    const check = checkSaleAmount({ amount: 999, intent: { amountCents: 100 } })
    expect(Object.keys(check).sort()).toEqual(
      ['advisory', 'basis', 'expectedAmount', 'gatewayAmount', 'matched'].sort(),
    )
    for (const key of ['reject', 'refuse', 'status', 'error', 'block']) {
      expect({ key, present: key in check }).toEqual({ key, present: false })
    }
  })
})
