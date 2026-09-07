/**
 * A MULTI-ORDER CHARGE IS RECONCILED AGAINST THE WHOLE SETTLEMENT.
 *
 * ==================================================================================================
 * THE GAP THIS CLOSES
 * ==================================================================================================
 *
 * `orders.paycloud_merchant_order_no` is minted on ONE row per payment -- the lead order, enforced
 * by a unique partial index. So both gateway-amount gates resolved exactly one order however many
 * were charged:
 *
 *   verify-payment    called with orderIds[0]
 *   paycloud webhook  resolver leg 1 matches the lead row
 *
 * Each compared the WHOLE gateway amount against ONE order's expectation. For o1 = N$10,
 * o2 = N$10 and a N$10 gratuity the reader is asked for N$30 and both expected N$20 -- refusing a
 * payment that had succeeded.
 *
 * This never worked. Before pending_charge_cents existed the same gates compared a summed gateway
 * amount against a single `order.total`.
 *
 * ==================================================================================================
 * NULL IS THE SAFETY STORY, AND IT IS TESTED AS HARD AS THE FEATURE
 * ==================================================================================================
 *
 * Every order on production has a NULL settlement id -- 3,317 with a merchant order number, 37 with
 * a pending charge, none with this. A NULL id must expand to the lead order alone and behave
 * exactly as it does today, or this change breaks every payment in the estate to fix a rare one.
 */
import { expectedChargeForOrders } from '@/lib/payments/expected-charge'
import { settlementSetFor } from '@/lib/payments/settlement-set'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'

const REST = 'rest-1'
const SET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type Row = {
  id: string
  restaurant_id?: string
  total: number
  pending_charge_cents?: number | null
  pending_tip_cents?: number | null
  pending_settlement_id?: string | null
}

/**
 * A supabase stand-in over a fixed table of orders.
 *
 * It applies BOTH filters the helper uses -- pending_settlement_id AND restaurant_id -- because a
 * fake that ignored the venue filter would let a cross-venue bug pass unnoticed, and this is the
 * money path.
 */
function db(rows: Row[], opts: { readFails?: boolean } = {}) {
  return {
    from() {
      const state: { settlementId?: string; restaurantId?: string } = {}
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: string) => {
          if (col === 'pending_settlement_id') state.settlementId = val
          if (col === 'restaurant_id') state.restaurantId = val
          return b
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (opts.readFails) {
            return Promise.resolve({ data: null, error: { message: 'read failed' } }).then(resolve)
          }
          const data = rows.filter(
            (r) =>
              String(r.pending_settlement_id ?? '') === String(state.settlementId ?? '') &&
              (state.restaurantId === undefined ||
                String(r.restaurant_id ?? REST) === state.restaurantId),
          )
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return b
    },
  } as never
}

/** What a gate does: expand, sum, compare exactly. */
async function verifies(
  gatewayAmount: number,
  lead: Row,
  all: Row[],
  opts?: { readFails?: boolean },
) {
  const set = await settlementSetFor(db(all, opts), lead, REST)
  const expected = expectedChargeForOrders(set.orders).expectedAmount
  return {
    expected,
    basis: set.basis,
    ok: amountsMatch(gatewayAmount, expected, GATEWAY_AMOUNT_TOLERANCE_CENTS),
    count: set.orders.length,
  }
}

const order = (id: string, total: number, over: Partial<Row> = {}): Row => ({
  id,
  restaurant_id: REST,
  total,
  ...over,
})

describe('A. SINGLE ORDER — existing behaviour unchanged', () => {
  it('N$20 with no settlement id expects N$20', async () => {
    const o1 = order('o1', 20, { pending_charge_cents: 2000, pending_settlement_id: null })
    const r = await verifies(20, o1, [o1])
    expect(r).toMatchObject({ expected: 20, basis: 'lead_order_only', ok: true, count: 1 })
  })

  it('N$20 WITH a settlement id of its own still expects N$20', async () => {
    // A single-order settlement now carries an id too. It must not change the answer.
    const o1 = order('o1', 20, { pending_charge_cents: 2000, pending_settlement_id: SET_A })
    const r = await verifies(20, o1, [o1])
    expect(r).toMatchObject({ expected: 20, basis: 'settlement_id', ok: true, count: 1 })
  })
})

describe('B. TWO ORDERS, no gratuity', () => {
  it('N$10 + N$10 expects N$20 and verifies', async () => {
    const o1 = order('o1', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const r = await verifies(20, o1, [o1, o2])
    expect(r).toMatchObject({ expected: 20, ok: true, count: 2 })
  })
})

describe('C. TWO ORDERS + GRATUITY — the reported case', () => {
  /** The gratuity rides on the lead order, per prepare-payment. */
  const o1 = order('o1', 10, {
    pending_charge_cents: 1000 + 1000,
    pending_tip_cents: 1000,
    pending_settlement_id: SET_A,
  })
  const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })

  it('expects N$30 and ACCEPTS a N$30 gateway amount', async () => {
    const r = await verifies(30, o1, [o1, o2])
    expect(r).toMatchObject({ expected: 30, ok: true, count: 2 })
  })

  it('the gratuity is counted exactly once', async () => {
    // Placing the tip on the lead order and summing must not double it -- the failure mode that
    // would make a gate expect MORE than was charged.
    const set = await settlementSetFor(db([o1, o2]), o1, REST)
    expect(expectedChargeForOrders(set.orders).tipCents).toBe(1000)
  })

  it('and it verifies identically when the WEBHOOK resolves the non-lead order', async () => {
    /**
     * The webhook resolves whichever row the reference matched. Expanding from either must give
     * the same set, or the two gates would disagree about the same charge.
     */
    const r = await verifies(30, o2, [o1, o2])
    expect(r).toMatchObject({ expected: 30, ok: true, count: 2 })
  })
})

describe('D. WRONG GATEWAY AMOUNT — fail safe, zero tolerance intact', () => {
  const o1 = order('o1', 10, {
    pending_charge_cents: 2000,
    pending_tip_cents: 1000,
    pending_settlement_id: SET_A,
  })
  const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })

  it.each([
    ['one cent under', 29.99],
    ['one cent over', 30.01],
    ['the lead order alone', 20],
    ['the bill without the tip', 20],
    ['zero', 0],
  ])('%s is REJECTED', async (_label, amount) => {
    const r = await verifies(amount as number, o1, [o1, o2])
    expect(r.ok).toBe(false)
  })

  it('the tolerance is still zero', () => {
    // Every rejection above would also pass at one cent, so without this the suite could not tell
    // exact from nearly-exact.
    expect(GATEWAY_AMOUNT_TOLERANCE_CENTS).toBe(0)
  })
})

describe('E. THE LEAD ORDER EXPANDS', () => {
  it('a settlement id pulls in every sibling', async () => {
    const o1 = order('o1', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const o3 = order('o3', 5, { pending_charge_cents: 500, pending_settlement_id: SET_A })
    const set = await settlementSetFor(db([o1, o2, o3]), o1, REST)
    expect(set.orders.map((r) => String(r.id)).sort()).toEqual(['o1', 'o2', 'o3'])
    expect(set.basis).toBe('settlement_id')
  })

  it('the lead order is present even if the lookup somehow omits it', async () => {
    /**
     * A concurrent prepare could clear the lead row mid-flight. Dropping it would make the
     * expectation SMALLER than the charge, which refuses a real payment.
     */
    const lead = order('o1', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const other = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const set = await settlementSetFor(db([other]), lead, REST)
    expect(set.orders.map((r) => String(r.id)).sort()).toEqual(['o1', 'o2'])
  })
})

describe('F/I. NULL SETTLEMENT ID — every order on production today', () => {
  it('resolves to the lead order alone, exactly as before', async () => {
    const o1 = order('o1', 20, { pending_charge_cents: null, pending_settlement_id: null })
    const other = order('o2', 10, { pending_settlement_id: SET_A })
    const set = await settlementSetFor(db([o1, other]), o1, REST)
    expect(set.orders).toEqual([o1])
    expect(set.basis).toBe('lead_order_only')
  })

  it('and falls back to the ORDER TOTAL, which is the pre-change rule', async () => {
    // 3,317 production orders have a merchant order number and none has a settlement id.
    const o1 = order('o1', 20)
    const r = await verifies(20, o1, [o1])
    expect(r).toMatchObject({ expected: 20, ok: true })
  })

  it('a FAILED expansion read also falls back rather than throwing', async () => {
    /**
     * The caller is mid-verification of a payment the gateway says succeeded. Refusing outright
     * over a failed read would strand an order for a reason unrelated to the money; the lead order
     * alone is the pre-existing behaviour and is fail-safe.
     */
    const o1 = order('o1', 20, { pending_charge_cents: 2000, pending_settlement_id: SET_A })
    const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const r = await verifies(20, o1, [o1, o2], { readFails: true })
    expect(r).toMatchObject({ basis: 'lead_order_only', expected: 20, count: 1 })
  })
})

describe('H. AN UNRELATED SETTLEMENT IS NEVER INCLUDED', () => {
  it('a different settlement id is excluded', async () => {
    /**
     * The failure that would make a gate expect MORE than was charged and refuse a real payment --
     * the opposite direction from the bug being fixed, and worse, because it hits every payment
     * rather than multi-order ones.
     */
    const o1 = order('o1', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const o2 = order('o2', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const stranger = order('x1', 99, { pending_charge_cents: 9900, pending_settlement_id: SET_B })

    const r = await verifies(20, o1, [o1, o2, stranger])
    expect(r).toMatchObject({ expected: 20, ok: true, count: 2 })
  })

  it('and neither is another VENUE sharing a settlement id', async () => {
    // A uuid collision is not realistic, but a cross-venue read on the money path is not something
    // to leave to probability -- the helper filters on restaurant_id and this proves it.
    const o1 = order('o1', 10, { pending_charge_cents: 1000, pending_settlement_id: SET_A })
    const elsewhere: Row = {
      id: 'other-venue',
      restaurant_id: 'rest-2',
      total: 50,
      pending_charge_cents: 5000,
      pending_settlement_id: SET_A,
    }
    const set = await settlementSetFor(db([o1, elsewhere]), o1, REST)
    expect(set.orders.map((r) => String(r.id))).toEqual(['o1'])
  })
})

describe('G. REPEATED PREPARATION — the identity is stable', () => {
  /**
   * prepare-payment reuses the LEAD ORDER's existing settlement id rather than minting a new one,
   * mirroring ensureTerminalMerchantOrderNo: an order that already holds a usable merchant order
   * number gets it back with created:false, because that value is never rotated.
   *
   * Asserted against source -- the route cannot be imported under ts-jest (jose is ESM-only) -- and
   * the question is static: does it read the existing id before minting?
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')
  const CODE = readFileSync(
    join(process.cwd(), 'app/api/terminal/orders/[orderId]/prepare-payment/route.ts'),
    'utf8',
  )

  it('the route was read — not an empty match', () => {
    expect(CODE.length).toBeGreaterThan(1000)
  })

  it('an existing settlement id is REUSED, not replaced', () => {
    expect(CODE).toMatch(/const existingSettlementId\s*=/)
    expect(CODE).toMatch(/existingSettlementId \?\? randomUUID\(\)/)
  })

  it('it is read off the LEAD order', () => {
    expect(CODE).toMatch(/const leadRow = orderRow\.find\(/)
    expect(CODE).toMatch(/leadRow\?\.pending_settlement_id/)
  })

  it('a narrower retry RELEASES orders that dropped out of the settlement', () => {
    /**
     * Prepare [o1,o2] then prepare [o1]: without this, o2 keeps the id, the expansion pulls it back
     * in, and both gates expect more than was charged.
     */
    expect(CODE).toMatch(/pending_settlement_id: null/)
    expect(CODE).toMatch(/\.eq\('pending_settlement_id', existingSettlementId\)/)
  })

  it('every participating order is written with the same id', () => {
    expect(CODE).toMatch(/pending_settlement_id: settlementId/)
  })

  it('the merchant order number is untouched by any of this', () => {
    // It remains THE gateway identity. Nothing here rotates it or sends anything new to PayCloud.
    expect(CODE).not.toMatch(/paycloud_merchant_order_no:\s*(null|randomUUID)/)
  })
})

describe('BOTH GATES EXPAND — asserted at the call sites', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  it.each([
    ['verify-payment', 'app/api/terminal/orders/[orderId]/verify-payment/route.ts'],
    ['paycloud webhook', 'app/api/webhooks/paycloud/route.ts'],
  ])('%s expands before summing, and selects the column', (_name, rel) => {
    const code = readFileSync(join(process.cwd(), rel), 'utf8')
    const statements = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(statements).toMatch(/settlementSetFor\(/)
    expect(statements).toMatch(/expectedChargeForOrders\(/)
    // SELECTED, not merely written: an unselected column reads as NULL and silently disables the
    // expansion, which is exactly what "no expansion" looks like.
    expect(statements).toMatch(/pending_settlement_id/)
  })

  it('the webhook does NOT depend on payment_events for the settlement set', () => {
    /**
     * recordSaleEvent runs AFTER settleTab, so a webhook arriving first finds no event. An identity
     * the webhook cannot rely on is not an identity.
     */
    const code = readFileSync(join(process.cwd(), 'app/api/webhooks/paycloud/route.ts'), 'utf8')
    const near = code.slice(
      Math.max(0, code.indexOf('settlementSetFor') - 1500),
      code.indexOf('settlementSetFor') + 1500,
    )
    expect(near).not.toMatch(/payment_events/)
  })
})
