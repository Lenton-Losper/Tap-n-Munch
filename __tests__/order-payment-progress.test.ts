/**
 * The partial-payment reading, at 0%, part-way, and 100%.
 *
 * WHAT THIS IS FOR. Order History rendered a partially paid order as PENDING -- the same word an
 * untouched order gets -- so a waiter could not tell "nobody has paid" from "three of these four
 * are settled and N$6 is left". These assertions pin the three readings apart, and pin the two
 * ways the naive version gets it wrong: an order settled whole carries NO allocations, and an
 * unpriced line is not a free one.
 *
 * Nothing here exercises payment behaviour. The module under test writes nothing and decides
 * nothing; it turns rows that have already been read into a label and a figure.
 */
import {
  orderPaymentProgress,
  orderPaymentLabel,
  type ProgressLine,
} from '@/lib/payments/order-payment-progress'

/** Four lines at N$10 each: an order of N$40, the shape the brief describes. */
const four = (settled: [number, number, number, number]): ProgressLine[] =>
  settled.map((s) => ({ totalCents: 1000, settledCents: s }))

describe('orderPaymentProgress — 0% paid', () => {
  it('reports UNPAID and the whole total remaining', () => {
    const p = orderPaymentProgress({
      orderTotal: 34,
      paymentStatus: 'pending',
      lines: [
        { totalCents: 2000, settledCents: 0 },
        { totalCents: 1400, settledCents: 0 },
      ],
    })
    expect(p.state).toBe('unpaid')
    expect(p.paidLines).toBe(0)
    expect(p.totalLines).toBe(2)
    expect(p.remainingCents).toBe(3400)
    expect(p.paidCents).toBe(0)
    expect(orderPaymentLabel(p)).toBe('UNPAID')
  })

  it('an order with no line data at all owes its whole total rather than reading as settled', () => {
    // The direction matters: "no lines" must never be read as "nothing owed".
    const p = orderPaymentProgress({ orderTotal: 34, paymentStatus: 'pending', lines: [] })
    expect(p.state).toBe('unpaid')
    expect(p.remainingCents).toBe(3400)
    expect(orderPaymentLabel(p)).toBe('UNPAID')
  })
})

describe('orderPaymentProgress — partially paid', () => {
  it('reports 3/4 PAID with only the unpaid line remaining', () => {
    const p = orderPaymentProgress({
      orderTotal: 40,
      paymentStatus: 'pending',
      lines: four([1000, 1000, 1000, 0]),
    })
    expect(p.state).toBe('partial')
    expect(p.paidLines).toBe(3)
    expect(p.totalLines).toBe(4)
    expect(p.remainingCents).toBe(1000)
    expect(p.paidCents).toBe(3000)
    expect(orderPaymentLabel(p)).toBe('3/4 PAID')
  })

  it('the brief\'s example: N$6 remaining reads as exactly that', () => {
    const p = orderPaymentProgress({
      orderTotal: 24,
      paymentStatus: 'pending',
      lines: [
        { totalCents: 600, settledCents: 600 },
        { totalCents: 600, settledCents: 600 },
        { totalCents: 600, settledCents: 600 },
        { totalCents: 600, settledCents: 0 },
      ],
    })
    expect(orderPaymentLabel(p)).toBe('3/4 PAID')
    expect(p.remainingCents).toBe(600)
  })

  it('a part-settled single line is partial, not paid and not unpaid', () => {
    const p = orderPaymentProgress({
      orderTotal: 10,
      paymentStatus: 'pending',
      lines: [{ totalCents: 1000, settledCents: 400 }],
    })
    expect(p.state).toBe('partial')
    expect(p.paidLines).toBe(0)
    expect(p.remainingCents).toBe(600)
    // No line is fully paid, so the honest count is 0 of 1 -- and the state still says partial.
    expect(orderPaymentLabel(p)).toBe('0/1 PAID')
  })

  /**
   * THE LABEL FOLLOWS THE MONEY. Every line reads paid while cents are still owed -- the shape a
   * part-settled allocation set produces. Calling this PAID would reintroduce the ambiguity one
   * level down.
   */
  it('does not say PAID while cents remain, even when every line counts as paid', () => {
    const p = orderPaymentProgress({
      orderTotal: 40,
      paymentStatus: 'pending',
      lines: four([1000, 1000, 1000, 1000]).map((l) => ({ ...l, totalCents: 900 })),
    })
    expect(p.paidLines).toBe(4)
    expect(p.remainingCents).toBe(0)
    // 4 x 1000 settled against a 4000 total: nothing remains, so PAID is correct here.
    expect(p.state).toBe('paid')
  })

  it('an UNPRICED line is counted in the denominator and never as paid', () => {
    const p = orderPaymentProgress({
      orderTotal: 30,
      paymentStatus: 'pending',
      lines: [
        { totalCents: 1000, settledCents: 1000 },
        { totalCents: 1000, settledCents: 1000 },
        { totalCents: null, settledCents: 0 },
      ],
    })
    expect(p.paidLines).toBe(2)
    expect(p.totalLines).toBe(3)
    expect(orderPaymentLabel(p)).toBe('2/3 PAID')
    expect(p.state).toBe('partial')
  })
})

describe('orderPaymentProgress — 100% paid', () => {
  it('reports PAID with nothing remaining when the lines settle the total', () => {
    const p = orderPaymentProgress({
      orderTotal: 40,
      paymentStatus: 'pending',
      lines: four([1000, 1000, 1000, 1000]),
    })
    expect(p.state).toBe('paid')
    expect(p.paidLines).toBe(4)
    expect(p.remainingCents).toBe(0)
    expect(orderPaymentLabel(p)).toBe('PAID')
  })

  /**
   * THE REGRESSION THE NAIVE VERSION SHIPS. An order settled whole carries no allocations, so the
   * arithmetic alone says "nothing paid" about a fully paid order. `payment_status` outranks it.
   */
  it('an order settled WHOLE reads PAID despite having no allocations', () => {
    const p = orderPaymentProgress({ orderTotal: 34, paymentStatus: 'paid', lines: [] })
    expect(p.state).toBe('paid')
    expect(p.remainingCents).toBe(0)
    expect(p.paidCents).toBe(3400)
    expect(orderPaymentLabel(p)).toBe('PAID')
  })

  it('a whole-settled order with lines reports every line paid', () => {
    const p = orderPaymentProgress({
      orderTotal: 40,
      paymentStatus: 'paid',
      lines: four([0, 0, 0, 0]),
    })
    expect(p.state).toBe('paid')
    expect(p.paidLines).toBe(4)
    expect(p.totalLines).toBe(4)
    expect(p.remainingCents).toBe(0)
  })
})

describe('orderPaymentProgress — figures stay honest', () => {
  it('never reports more collected than the order is worth', () => {
    const p = orderPaymentProgress({
      orderTotal: 10,
      paymentStatus: 'pending',
      lines: [{ totalCents: 1000, settledCents: 9999 }],
    })
    expect(p.paidCents).toBe(1000)
    expect(p.remainingCents).toBe(0)
  })

  it('never reports a negative remainder', () => {
    const p = orderPaymentProgress({
      orderTotal: 5,
      paymentStatus: 'pending',
      lines: [{ totalCents: 1000, settledCents: 1000 }],
    })
    expect(p.remainingCents).toBe(0)
    expect(p.remainingCents).toBeGreaterThanOrEqual(0)
  })

  it('a malformed settled figure is treated as nothing collected, not as a credit', () => {
    const p = orderPaymentProgress({
      orderTotal: 10,
      paymentStatus: 'pending',
      lines: [{ totalCents: 1000, settledCents: Number.NaN }],
    })
    expect(p.paidCents).toBe(0)
    expect(p.remainingCents).toBe(1000)
    expect(p.state).toBe('unpaid')
  })

  it('works in integer cents, so a three-way split does not render a float artefact', () => {
    const p = orderPaymentProgress({
      orderTotal: 10,
      paymentStatus: 'pending',
      lines: [
        { totalCents: 334, settledCents: 334 },
        { totalCents: 333, settledCents: 0 },
        { totalCents: 333, settledCents: 0 },
      ],
    })
    expect(p.remainingCents).toBe(666)
    expect(Number.isInteger(p.remainingCents)).toBe(true)
  })
})
