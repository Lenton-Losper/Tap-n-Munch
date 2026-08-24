import { looksLikeOrderId, isWellFormedPaymentRef, paymentRefOrFilter } from '@/lib/guest-orders/validation'

/**
 * #337 — AN ORDER ID IS NOT A PAYMENT REFERENCE, and the confirmation screen passes one.
 *
 * The screen accepts `orderId` / `order_id` as its reference. The lookup built a PostgREST filter
 * over `payment_reference` and `paycloud_merchant_order_no` — neither of which ever holds an order
 * id — so the filter was constructed and matched nothing, every time. The customer saw
 * "Order not found" for an order that existed and was being prepared.
 *
 * The trap that hid it: a UUID satisfies PAYMENT_REF_PATTERN (`[A-Za-z0-9-]{1,64}`), so nothing
 * refused the input. It looked like a valid reference that simply had no match.
 *
 * BOTH DIRECTIONS ARE ASSERTED, because the two ways to get this wrong pull opposite:
 *   too NARROW — an order id still fails to resolve (today's defect)
 *   too WIDE   — a real payment reference stops taking the reference path, or an id-shaped string
 *                widens the `.or()` filter, which is the #242/#254 injection shape
 */
const ORDER_ID = '5fe2cd4e-37a9-489a-9a55-4b1d44df2b95'
const PAYMENT_REF = 'PAY-20260808-K7M2QRTZ'
const MERCHANT_ORDER_NO = 'FT17872970116626363'

describe('an order id is recognised as an order id', () => {
  it('recognises the reference from the reported incident', () => {
    expect(looksLikeOrderId(ORDER_ID)).toBe(true)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(looksLikeOrderId(ORDER_ID.toUpperCase())).toBe(true)
    expect(looksLikeOrderId(`  ${ORDER_ID}  `)).toBe(true)
  })
})

describe('a real payment reference is NOT treated as an order id', () => {
  it('leaves our own payment references on the reference path', () => {
    // If this flips, every genuine gateway return stops resolving — the opposite defect.
    expect(looksLikeOrderId(PAYMENT_REF)).toBe(false)
    expect(looksLikeOrderId(MERCHANT_ORDER_NO)).toBe(false)
  })

  it('and those still build a reference filter, exactly as before', () => {
    expect(paymentRefOrFilter(PAYMENT_REF)).toBe(
      `paycloud_merchant_order_no.eq.${PAYMENT_REF},payment_reference.eq.${PAYMENT_REF}`,
    )
    expect(paymentRefOrFilter(MERCHANT_ORDER_NO)).toContain(MERCHANT_ORDER_NO)
  })

  it('near-misses are not mistaken for ids', () => {
    for (const s of [
      '5fe2cd4e37a9489a9a5541d44df2b95',                 // no hyphens
      '5fe2cd4e-37a9-489a-9a55',                         // truncated
      '5fe2cd4e-37a9-489a-9a55-41d44df2b95z',            // trailing char
      'zzzzzzzz-37a9-489a-9a55-41d44df2b953',            // non-hex
    ]) {
      expect(looksLikeOrderId(s)).toBe(false)
    }
  })
})

describe('the validator that hid this', () => {
  it('a UUID passes the payment-ref shape check, which is why nothing refused it', () => {
    // Documents the reason the defect was silent rather than loud. Not a bug in itself.
    expect(isWellFormedPaymentRef(ORDER_ID)).toBe(true)
  })

  it('an id-shaped string still cannot widen the .or() filter', () => {
    // #242/#254 shape: a comma would add OR terms. The id path must not reopen that.
    expect(paymentRefOrFilter(`${ORDER_ID},total.gte.0`)).toBeNull()
    expect(looksLikeOrderId(`${ORDER_ID},total.gte.0`)).toBe(false)
  })
})
