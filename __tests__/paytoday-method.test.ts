/**
 * PAYTODAY AS A THIRD SETTLEMENT METHOD — the gates that keep it from being treated as a card.
 *
 * ==================================================================================================
 * THE CLASS OF DEFECT THIS GUARDS
 * ==================================================================================================
 *
 * Before PayToday there were two methods, so seven separate places wrote `isCashSettlement ? x : y`
 * and MEANT "not cash, therefore card". A third value makes that reading false rather than merely
 * incomplete: PayToday would have taken every card branch and been handed a voucher number, a
 * gateway reference, and a card-shaped masked token on the customer's receipt — for a transaction no
 * gateway has ever heard of.
 *
 * That is the "typechecks and then prints wrong" shape. `'paytoday'` satisfies every `string` in the
 * codebase; nothing would have thrown.
 *
 * PayToday is an ASSERTION. The waiter takes the money in Nedbank's own app, outside FlashTap. No
 * reader, no gateway call, no webhook, no credential — and FlashTap therefore has NO PROOF the
 * payment arrived. That is weaker than cash, which is at least countable in a drawer.
 */
import {
  SETTLEMENT_PAYMENT_METHODS,
  methodUsesGateway,
  normalizeSettlementPaymentMethod,
  settleableStatusesForMethod,
} from '@/lib/payments/payment-integrity'
import { formatPaymentLabel } from '@/lib/receipts/formatPaymentLabel'
import { paymentMethodLabel, PAYMENT_METHOD_LABELS } from '@/lib/reports/payment-method-split'

describe('the settlement allowlist', () => {
  it('accepts paytoday', () => {
    expect(normalizeSettlementPaymentMethod('paytoday')).toBe('paytoday')
    expect([...SETTLEMENT_PAYMENT_METHODS]).toContain('paytoday')
  })

  it('normalises case and whitespace, like the other two', () => {
    // A stored 'PayToday' would print correctly on a receipt and read as unknown everywhere else.
    expect(normalizeSettlementPaymentMethod(' PayToday ')).toBe('paytoday')
  })

  it('NEGATIVE CONTROL: it still refuses things that are not methods', () => {
    /**
     * Without this, "paytoday is accepted" could be satisfied by an allowlist that accepts
     * everything — which is exactly what the route's 400 exists to prevent.
     */
    expect(normalizeSettlementPaymentMethod('mobile_money')).toBeNull()
    expect(normalizeSettlementPaymentMethod('online')).toBeNull()
    expect(normalizeSettlementPaymentMethod('')).toBeNull()
  })

  it('mobile_money is NOT the canonical name', () => {
    /**
     * Owner's ruling 2026-09-09. `mobile_money` was already permitted by the settings CHECK and
     * would have needed no migration — and is still wrong, because it names a CATEGORY. A second
     * mobile product at another venue would be indistinguishable from this one in every report,
     * receipt and cash-up, with no way to separate them afterwards.
     */
    expect([...SETTLEMENT_PAYMENT_METHODS]).not.toContain('mobile_money')
  })
})

describe('PAYTODAY NEVER LOOKS LIKE A GATEWAY TRANSACTION', () => {
  it('methodUsesGateway is true for card ONLY', () => {
    /**
     * The single predicate that replaced seven `isCashSettlement ? x : y` ternaries. Everything that
     * decides whether to attach a voucher number or a gateway reference now asks this.
     */
    expect(methodUsesGateway('card')).toBe(true)
    expect(methodUsesGateway('cash')).toBe(false)
    expect(methodUsesGateway('paytoday')).toBe(false)
  })

  it('a receipt prints PAYTODAY and no masked reference', () => {
    /**
     * The rule used to be "anything that is not cash gets METHOD + a masked reference". A masked
     * token on a PayToday receipt would look like a card artefact and correlate to nothing — the
     * customer's copy would imply a transaction anybody could look up.
     */
    expect(formatPaymentLabel('paytoday', 'XXXX1234')).toBe('PAYTODAY')
    expect(formatPaymentLabel('paytoday', '')).toBe('PAYTODAY')
  })

  it('POSITIVE CONTROL: a card receipt still shows its masked reference', () => {
    // Without this, suppressing the reference for everything would satisfy the assertion above
    // while stripping the one method that genuinely has an artefact worth printing.
    expect(formatPaymentLabel('card', 'XXXX1234')).toBe('CARD XXXX1234')
    expect(formatPaymentLabel('cash', 'XXXX1234')).toBe('CASH')
  })
})

describe('PAYTODAY IS CASH-SHAPED FOR SETTLEABILITY', () => {
  it('it gets the cash status set, not the card one', () => {
    /**
     * The wider CASH set exists because a settlement taken OUTSIDE the gateway can legitimately land
     * on an order the gateway left mid-flight — there is no card in a reader to collide with. That
     * is exactly PayToday's situation.
     *
     * Giving it the CARD set would refuse settlements for orders a waiter has genuinely been paid
     * for, which is how a table cannot be closed after the customer has left.
     */
    expect(settleableStatusesForMethod('paytoday')).toEqual(
      settleableStatusesForMethod('cash'),
    )
  })

  it('and card keeps its own, narrower set', () => {
    // The control. If all three returned the same set, the assertion above passes while the
    // card-in-flight protection silently disappears.
    expect(settleableStatusesForMethod('card')).not.toEqual(
      settleableStatusesForMethod('cash'),
    )
  })
})

describe('REPORTING TREATS IT AS REVENUE, LIKE CASH', () => {
  it('it has a display label, and is not printed as a raw key', () => {
    // Owner's ruling: revenue like cash. So it is an ordinary takings row, capitalised as Nedbank
    // writes it — not `paytoday` in lower case in front of a manager.
    expect(paymentMethodLabel('paytoday')).toBe('PayToday')
    expect(PAYMENT_METHOD_LABELS.paytoday).toBe('PayToday')
  })

  it('an unmapped method still falls back to its raw key rather than vanishing', () => {
    // The fallback must stay: a row silently dropped from a takings report is money that
    // reconciles to nothing.
    expect(paymentMethodLabel('some_future_method')).toBe('some_future_method')
  })
})

describe('v1 SCOPE IS ENFORCED, NOT DOCUMENTED', () => {
  it('the split-settlement RPC and its table still refuse paytoday', () => {
    /**
     * v1 is WHOLE-ORDER ONLY. order_line_allocation_settlements.method and payment_tips.method are
     * both still CHECK (method IN ('cash','card')), and settle_order_line_allocations RAISEs on
     * anything else — deliberately left alone so a split PayToday or a PayToday tip fails loudly
     * rather than silently recording something the product does not support.
     *
     * Asserted against the migration SOURCE, because that is what the database enforces. If someone
     * widens those constraints, this fails and the route-level refusals must be revisited with it.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path')

    const alloc = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260829170000_order_line_allocations.sql'),
      'utf8',
    )
    expect(alloc).toContain("method text NOT NULL CHECK (method IN ('cash', 'card'))")
    expect(alloc).toContain("IF p_method NOT IN ('cash', 'card') THEN")

    const tips = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260905120000_payment_tips.sql'),
      'utf8',
    )
    expect(tips).toContain("method text NOT NULL CHECK (method IN ('cash', 'card'))")
  })

  it('the paytoday migration widens exactly two constraints and no others', () => {
    /**
     * A census of the migration itself. Widening order_line_allocation_settlements or payment_tips
     * here would silently open v2 scope, and the loud failures above are the only thing currently
     * stopping a split PayToday from being recorded.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path')
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260909160000_paytoday_payment_method.sql'),
      'utf8',
    )
    /**
     * COMMENTS STRIPPED FIRST. The migration's own prose NAMES the two constraints it deliberately
     * leaves alone, so a raw search finds them and reports the opposite of the truth. Caught exactly
     * that way while writing this -- the same "assert the condition, not the marker string" mistake
     * that produced four defects in one day on this project.
     */
    const statements = sql.replace(/^\s*--.*$/gm, '')

    const altered = [...statements.matchAll(/ALTER TABLE\s+public\.(\w+)/g)].map((m) => m[1])
    expect([...new Set(altered)].sort()).toEqual(['payments', 'restaurant_settings'])
    expect(statements).not.toMatch(/order_line_allocation_settlements/)
    expect(statements).not.toMatch(/payment_tips/)
    expect(statements).not.toMatch(/kiosk_payment_methods/)
  })
})
