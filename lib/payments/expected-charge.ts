/**
 * WHAT THE READER WAS ASKED TO CHARGE — the single authority, for every gate.
 *
 * ==================================================================================================
 * THE INVARIANT
 * ==================================================================================================
 *
 * THE AMOUNT SENT TO THE GATEWAY MUST BE THE AMOUNT VERIFICATION COMPARES AGAINST.
 *
 * The split path already holds to it: an intent's amount_cents is both what the reader is told to
 * charge and what a gateway echo is reconciled against. The whole-order path did not. Three gates
 * independently recomputed `order.total`:
 *
 *   app/api/terminal/orders/[orderId]/verify-payment/route.ts
 *   app/api/webhooks/paycloud/route.ts
 *   app/api/payments/reconcile/route.ts
 *
 * Three copies of one rule is the shape that drifts, and it drifted the moment a gratuity existed:
 * add a tip to the charge and all three refuse a payment that SUCCEEDED, after the customer's card
 * has already been debited. Which is why the tip was never added to the charge at all — and was
 * instead recorded as collected while the customer paid the bill alone.
 *
 * ==================================================================================================
 * ZERO TOLERANCE IS NOT WEAKENED, AND THERE IS NO TIP TOLERANCE
 * ==================================================================================================
 *
 * GATEWAY_AMOUNT_TOLERANCE_CENTS stays zero. Finatic echoes back OUR OWN figure, so a cent of
 * daylight means the reference correlated to a DIFFERENT SALE. A "tip tolerance" would accept any
 * amount within a band of the order total and turn a byte-exact correlation check into a fuzzy one,
 * on the money path, to make a feature work.
 *
 * The fix is to make our own figure correct — not to stop checking it.
 */

/** The subset of an order row these functions need. Deliberately minimal so any caller can supply it. */
export type ChargeExpectationRow = {
  total?: unknown
  pending_charge_cents?: unknown
  pending_tip_cents?: unknown
}

/** Columns a caller must SELECT for expectedChargeFor to see a recorded expectation. */
export const EXPECTED_CHARGE_COLUMNS = 'total, pending_charge_cents, pending_tip_cents'

export type ChargeExpectation = {
  /** Major units, for comparison against a gateway amount. */
  expectedAmount: number
  /** Where the figure came from. Carried so a refusal can say which rule refused it. */
  basis: 'recorded_attempt' | 'order_total'
  /** Gratuity inside expectedAmount, in cents. Zero unless an attempt recorded one. */
  tipCents: number
}

function toCents(major: unknown): number {
  const n = Number(major)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

function positiveInt(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  return rounded > 0 ? rounded : null
}

/**
 * What ONE order's charge should have been.
 *
 * PREFERS THE RECORDED ATTEMPT. `pending_charge_cents` is written before the reader is launched and
 * is the only thing that knows a gratuity was included.
 *
 * FALLS BACK TO THE ORDER TOTAL, and that fallback is load-bearing rather than defensive: every
 * order placed before this existed has no recorded attempt, as does every path that never prepares
 * a charge. Without it, deploying this would refuse every in-flight payment in the estate.
 *
 * The fallback can only ever be WRONG IN THE SAFE DIRECTION — it is the behaviour that shipped for
 * a year, and it cannot invent a larger expectation than was actually asked for.
 */
export function expectedChargeFor(row: ChargeExpectationRow): ChargeExpectation {
  const recorded = positiveInt(row?.pending_charge_cents)
  if (recorded !== null) {
    const tip = Math.max(0, Math.round(Number(row?.pending_tip_cents ?? 0)) || 0)
    return {
      expectedAmount: recorded / 100,
      basis: 'recorded_attempt',
      // A tip that somehow exceeds the charge is not usable arithmetic; report none rather than a
      // negative order amount downstream.
      tipCents: tip < recorded ? tip : 0,
    }
  }
  return {
    expectedAmount: toCents(row?.total) / 100,
    basis: 'order_total',
    tipCents: 0,
  }
}

/**
 * What a charge covering SEVERAL orders should have been — the webhook and reconcile cases, where
 * one gateway amount answers for a set.
 *
 * Summed per order so a set that mixes prepared and unprepared orders still produces one honest
 * figure, rather than an all-or-nothing choice between the two rules.
 */
export function expectedChargeForOrders(rows: ChargeExpectationRow[]): ChargeExpectation {
  let cents = 0
  let tipCents = 0
  let anyRecorded = false

  for (const row of rows ?? []) {
    const one = expectedChargeFor(row)
    cents += Math.round(one.expectedAmount * 100)
    tipCents += one.tipCents
    if (one.basis === 'recorded_attempt') anyRecorded = true
  }

  return {
    expectedAmount: cents / 100,
    basis: anyRecorded ? 'recorded_attempt' : 'order_total',
    tipCents,
  }
}
