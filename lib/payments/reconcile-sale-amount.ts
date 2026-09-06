import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'
import type { PaymentIntent } from '@/lib/payments/payment-intents'

/**
 * DID THE GATEWAY CHARGE WHAT WE ASKED FOR?
 *
 * ================================================================================================
 * THE DEFECT
 * ================================================================================================
 *
 * POST /api/terminal/payment-events/sale validated that its `order_ids` exist and belong to the
 * restaurant, and that `amount > 0`, and then compared that amount to NOTHING. One figure, N
 * orders, no check. A card charged for the wrong amount was recorded as faithfully as a correct
 * one, and the only way to notice was to add the orders up by hand afterwards.
 *
 * ================================================================================================
 * WHY IT COULD NOT BE FIXED BEFORE INTENTS EXISTED
 * ================================================================================================
 *
 * The obvious comparison — amount against the sum of the named orders' totals — is LEGITIMATELY
 * WRONG for a settlement. A payment_events row is per-SETTLE, never per-order: a settlement may be
 * partial, may carry a gratuity that is deliberately outside the order total, and a tab settle
 * covers several orders at once. Enforcing that equality would have manufactured mismatches on
 * correct payments, which is why the obvious fix would have been a new defect.
 *
 * An intent records WHAT WE ASKED THE READER TO CHARGE. That is the honest comparison, and it is
 * available for exactly the payments that have one.
 *
 * ================================================================================================
 * IT RECORDS. IT NEVER REFUSES.
 * ================================================================================================
 *
 * This route runs AFTER the money has moved. Refusing to record a real charge would leave a
 * customer charged and the system unaware of it — strictly worse than recording it flagged. So a
 * mismatch is never a rejection: the event is written either way, and the discrepancy is reported
 * so a human sees both figures. That is the stance the webhook already takes for a multi-order
 * settlement (settlementGatewayAmount / settlementExpectedAmount); this extends it rather than
 * inventing a second one.
 */

export type SaleAmountBasis =
  /** The amount the reader was asked for. Exact: a gateway echo gets no tolerance. */
  | 'intent'
  /** Sum of the named orders' totals. Advisory only — see `advisory` below. */
  | 'order_totals'
  /** Nothing to compare against, so nothing is claimed. */
  | 'none'

export type SaleAmountCheck = {
  basis: SaleAmountBasis
  /** What the gateway says it charged, in major units, as recorded on the event. */
  gatewayAmount: number
  /** What we expected, in major units. Null when there is nothing to expect. */
  expectedAmount: number | null
  matched: boolean
  /**
   * TRUE when a mismatch is not, on its own, evidence of anything wrong.
   *
   * A settlement legitimately differs from the sum of order totals — partial payments, gratuities,
   * multi-order settles. So an `order_totals` mismatch is worth SAYING and is not worth alarming
   * about, while an `intent` mismatch means the reader charged something other than the figure it
   * was handed, which is always worth a human.
   */
  advisory: boolean
}

/**
 * Compares a recorded sale amount against the best available expectation.
 *
 * `intent` wins when there is one, because it is the only figure that means "what we asked for".
 * Order totals are the fallback for the whole-order path, which mints no intent and is deliberately
 * left alone.
 */
export function checkSaleAmount(params: {
  amount: number
  intent?: Pick<PaymentIntent, 'amountCents'> | null
  orderTotals?: number[] | null
}): SaleAmountCheck {
  const gatewayAmount = Number(params.amount)

  if (params.intent) {
    // Integer cents on the intent, major units on the event: compare in one currency of thought.
    const expectedAmount = params.intent.amountCents / 100
    return {
      basis: 'intent',
      gatewayAmount,
      expectedAmount,
      // ZERO tolerance. This is a gateway echo of a figure WE chose and handed over, not a client
      // proposing an amount — there is no rounding step between the two for a cent to hide in.
      matched: amountsMatch(gatewayAmount, expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS),
      advisory: false,
    }
  }

  const totals = params.orderTotals ?? []
  if (totals.length === 0) {
    return { basis: 'none', gatewayAmount, expectedAmount: null, matched: true, advisory: true }
  }

  const expectedAmount = totals.reduce((sum, t) => sum + (Number.isFinite(t) ? Number(t) : 0), 0)
  return {
    basis: 'order_totals',
    gatewayAmount,
    expectedAmount,
    matched: amountsMatch(gatewayAmount, expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS),
    /**
     * ADVISORY, and this is the whole reason the basis is carried rather than just a boolean. A
     * settlement that differs from the sum of order totals may be perfectly correct; one that
     * differs from what the reader was asked for cannot be.
     */
    advisory: true,
  }
}

/** The audit row a mismatch produces. Written for every named order, so it is findable from any. */
export const SALE_AMOUNT_MISMATCH_ACTION = 'payment.sale_amount_mismatch'

export function saleAmountMismatchAudit(params: {
  restaurantId: string
  orderId: string
  businessOrderNo: string
  check: SaleAmountCheck
}) {
  return {
    restaurant_id: params.restaurantId,
    action: SALE_AMOUNT_MISMATCH_ACTION,
    entity_type: 'order',
    entity_id: params.orderId,
    metadata: {
      businessOrderNo: params.businessOrderNo,
      /**
       * NAMED FOR WHOSE FIGURE EACH IS, not as a generic `amount`. #238/#268 turned on exactly this:
       * a field called `clientAmount` that held the order's own total at four of six call sites.
       */
      gatewayAmount: params.check.gatewayAmount,
      expectedAmount: params.check.expectedAmount,
      expectedFrom: params.check.basis,
      /** True when the difference may be legitimate. A reader is expected to read this first. */
      advisory: params.check.advisory,
      note:
        params.check.basis === 'intent'
          ? 'The reader charged an amount other than the one it was handed. The payment IS recorded; reconcile against the gateway.'
          : 'A settlement may legitimately differ from the sum of order totals (partial payment, gratuity, multi-order settle). Recorded for visibility, not as evidence of a fault.',
    },
  }
}
