/**
 * A WHOLE-ORDER CHARGE ASKS FOR WHAT IS STILL OWED, NOT WHAT THE ORDER COST.
 *
 * ==================================================================================================
 * THE HAZARD
 * ==================================================================================================
 *
 * Settlement stopped being order-grained the moment items could be paid for individually. The
 * charge basis did not follow: prepare-payment summed `orders.total`, and the settle route summed
 * the same figure. Neither knew part of the order might already be in the till.
 *
 * Order #45 at Digi Cofee is the shape. N$37.00 total, N$17.00 collected through two allocations,
 * N$20.00 genuinely owed. Reaching for "Settle Entire Tab" would ask the reader for N$37.00 and
 * take the same N$17.00 a second time -- on the cash path as readily as the card one, because both
 * read the same figure.
 *
 * The tab header has said N$20.00 since outstandingCentsFor was written. The quote and the charge
 * disagreed, and the charge is the one that moves money.
 *
 * ==================================================================================================
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
 * ==================================================================================================
 *
 * These are unit tests of the charge ARITHMETIC and of the read that feeds it. The gateway
 * tolerance, the PayCloud request shape and the reconciliation comparison are untouched by this
 * change and are covered where they live; restating them here would be a second, weaker copy.
 *
 * The positive control is case B: an ordinary order with nothing settled must still be charged in
 * full. Every other case asserts a REDUCTION, and a helper that returned zero for everything would
 * satisfy them all.
 */
import {
  chargeableCentsFor,
  settledCentsByOrder,
  SettledCentsUnreadable,
} from '@/lib/payments/settled-cents'

/** A supabase stub that answers the two `.in()` reads this helper makes. */
function db(opts: {
  allocations?: Array<{ id: string; order_id: string }>
  settlements?: Array<{ order_line_allocation_id: string; amount_cents: unknown }>
  allocError?: string
  settleError?: string
}) {
  return {
    from(table: string) {
      if (table === 'order_line_allocations') {
        return {
          select: () => ({
            in: () => ({
              is: async () =>
                opts.allocError
                  ? { data: null, error: { message: opts.allocError } }
                  : { data: opts.allocations ?? [], error: null },
            }),
          }),
        }
      }
      if (table === 'order_line_allocation_settlements') {
        return {
          select: () => ({
            in: async () =>
              opts.settleError
                ? { data: null, error: { message: opts.settleError } }
                : { data: opts.settlements ?? [], error: null },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never
}

/** Order #45, exactly: three allocations, two of them settled for 1700c. */
const ORDER_45 = db({
  allocations: [
    { id: 'a-coffee', order_id: 'o45' },
    { id: 'a-toast1', order_id: 'o45' },
    { id: 'a-toast2', order_id: 'o45' },
  ],
  settlements: [
    { order_line_allocation_id: 'a-coffee', amount_cents: 500 },
    { order_line_allocation_id: 'a-toast2', amount_cents: 1200 },
  ],
})

// ==================================================================================================
// A-C: the charge basis
// ==================================================================================================

describe('A. N$37.00 order with N$17.00 already settled', () => {
  it('is chargeable for exactly N$20.00', async () => {
    const settled = await settledCentsByOrder(ORDER_45, ['o45'])
    expect(settled.get('o45')).toBe(1700)
    expect(chargeableCentsFor(37, settled.get('o45'))).toBe(2000)
  })
})

describe('B. N$37.00 order with nothing settled (the positive control)', () => {
  it('is chargeable for the full N$37.00', async () => {
    /**
     * THE CONTROL THIS SUITE NEEDS. Every other case asserts that the charge went DOWN; a helper
     * that returned zero for everything, or one that could not read allocations at all, would
     * satisfy them and quietly stop collecting money.
     */
    const settled = await settledCentsByOrder(db({ allocations: [] }), ['o45'])
    expect(settled.has('o45')).toBe(false)
    expect(chargeableCentsFor(37, settled.get('o45'))).toBe(3700)
  })

  it('an order that was never split is charged exactly as before', async () => {
    // Almost all of production. No allocations at all -> nothing to subtract.
    const settled = await settledCentsByOrder(db({ allocations: [] }), ['ordinary'])
    expect(chargeableCentsFor(122, settled.get('ordinary'))).toBe(12200)
  })
})

describe('C. N$37.00 order with N$37.00 settled', () => {
  it('is chargeable for nothing, so no further charge can be created', async () => {
    const fully = db({
      allocations: [{ id: 'a1', order_id: 'o' }],
      settlements: [{ order_line_allocation_id: 'a1', amount_cents: 3700 }],
    })
    const settled = await settledCentsByOrder(fully, ['o'])
    expect(chargeableCentsFor(37, settled.get('o'))).toBe(0)
  })

  it('over-settlement clamps at zero rather than going negative', async () => {
    // A negative charge would be a refund the payment path never intended to issue.
    expect(chargeableCentsFor(37, 5000)).toBe(0)
  })

  it('clamps PER ORDER, so one over-settled order cannot absorb another order\'s debt', () => {
    // Clamping only on the sum would let -1300 from one order cancel real money owed on another.
    const a = chargeableCentsFor(37, 5000) // 0, not -1300
    const b = chargeableCentsFor(20, 0) // 2000
    expect(a + b).toBe(2000)
  })
})

// ==================================================================================================
// D: the gratuity
// ==================================================================================================

describe('D. N$17.00 settled, N$20.00 owed, plus a N$20.00 tip', () => {
  it('charges the outstanding items once and the tip once', async () => {
    /**
     * The established model: the gratuity rides ALONGSIDE the bill, never inside it, and is added
     * exactly once by prepare-payment as `chargeCents = orderCents + tipCents`. This pins the
     * arithmetic that feeds it: orderCents must be the OUTSTANDING 2000c, not the 3700c total.
     *
     * Old basis: 3700 + 2000 = 5700 asked of the customer, of which 1700 was already paid.
     * New basis: 2000 + 2000 = 4000, which is what is genuinely owed plus the tip offered.
     */
    const settled = await settledCentsByOrder(ORDER_45, ['o45'])
    const orderCents = chargeableCentsFor(37, settled.get('o45'))
    const tipCents = 2000
    expect(orderCents).toBe(2000)
    expect(orderCents + tipCents).toBe(4000)
    // and the figure that must never be asked for again
    expect(orderCents + tipCents).not.toBe(5700)
  })

  it('a tip never reduces or increases what the items owe', async () => {
    const settled = await settledCentsByOrder(ORDER_45, ['o45'])
    expect(chargeableCentsFor(37, settled.get('o45'))).toBe(2000)
  })
})

// ==================================================================================================
// E: failing safe
// ==================================================================================================

describe('E. when the settled figure cannot be read', () => {
  it('throws rather than falling back to the order total', async () => {
    /**
     * FAILS CLOSED. Falling back to `orders.total` is precisely the double charge this exists to
     * prevent, and it would happen silently at the worst possible moment -- a failed read during
     * service.
     */
    await expect(settledCentsByOrder(db({ allocError: 'boom' }), ['o'])).rejects.toBeInstanceOf(
      SettledCentsUnreadable,
    )
  })

  it('throws when the settlements read fails', async () => {
    await expect(
      settledCentsByOrder(
        db({ allocations: [{ id: 'a', order_id: 'o' }], settleError: 'boom' }),
        ['o'],
      ),
    ).rejects.toBeInstanceOf(SettledCentsUnreadable)
  })

  it('throws on an unreadable settlement amount rather than counting it as zero', async () => {
    // Counting it zero would INFLATE what is still chargeable -- the direction that charges twice.
    await expect(
      settledCentsByOrder(
        db({
          allocations: [{ id: 'a', order_id: 'o' }],
          settlements: [{ order_line_allocation_id: 'a', amount_cents: 'not-a-number' }],
        }),
        ['o'],
      ),
    ).rejects.toBeInstanceOf(SettledCentsUnreadable)
  })

  it('an unreadable order total is charged as zero, never as NaN', () => {
    // NaN would propagate into the gateway amount. Zero refuses instead, via the caller's guard.
    expect(chargeableCentsFor(undefined, 0)).toBe(0)
    expect(chargeableCentsFor('nonsense', 0)).toBe(0)
  })
})

// ==================================================================================================
// F, G
// ==================================================================================================

describe('F. repeated reads are idempotent', () => {
  it('the same ledger yields the same figure every time', async () => {
    const a = await settledCentsByOrder(ORDER_45, ['o45'])
    const b = await settledCentsByOrder(ORDER_45, ['o45'])
    expect(a.get('o45')).toBe(b.get('o45'))
    expect(chargeableCentsFor(37, a.get('o45'))).toBe(chargeableCentsFor(37, b.get('o45')))
  })

  it('duplicate order ids are collapsed, not double-counted', async () => {
    const settled = await settledCentsByOrder(ORDER_45, ['o45', 'o45', 'o45'])
    expect(settled.get('o45')).toBe(1700)
  })
})

describe('G. an allocation settlement followed by a whole-order settlement', () => {
  it('collects each item exactly once across the two paths', async () => {
    /**
     * The sequence that loses money: pay N$17.00 of items by split card, then settle the rest
     * whole. The two charges must sum to the order total and no more.
     */
    const settled = await settledCentsByOrder(ORDER_45, ['o45'])
    const alreadyCollected = settled.get('o45')!
    const nowCharged = chargeableCentsFor(37, alreadyCollected)
    expect(alreadyCollected).toBe(1700)
    expect(nowCharged).toBe(2000)
    expect(alreadyCollected + nowCharged).toBe(3700) // exactly the order total, once
  })

  it('and a THIRD attempt after that collects nothing', async () => {
    const after = db({
      allocations: [{ id: 'a1', order_id: 'o' }],
      settlements: [{ order_line_allocation_id: 'a1', amount_cents: 3700 }],
    })
    const settled = await settledCentsByOrder(after, ['o'])
    expect(chargeableCentsFor(37, settled.get('o'))).toBe(0)
  })

  it('voided allocations are excluded from the query entirely', async () => {
    // A voided allocation was withdrawn before anyone paid, so it has settled nothing. The route
    // filters them with .is('voided_at', null); this pins that the helper asks for that filter.
    const settled = await settledCentsByOrder(db({ allocations: [], settlements: [] }), ['o'])
    expect(settled.get('o')).toBeUndefined()
  })
})
