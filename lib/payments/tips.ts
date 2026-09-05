/**
 * Gratuity capture. One place that decides what a tip is and refuses everything else.
 *
 * ============================================================================================
 * THE TAX CONSTRAINT — THE REASON THIS MODULE EXISTS SEPARATELY FROM ORDER PRICING
 * ============================================================================================
 *
 * A FREELY GIVEN GRATUITY IS NOT CONSIDERATION FOR THE SUPPLY, so it sits OUTSIDE the VAT base.
 * That is the whole reason a tip never touches `orders.total` and never passes through
 * `lib/orders/calculate-order-pricing.ts`: keeping it out of the order keeps it out of the VAT
 * base BY CONSTRUCTION rather than by a filter someone can later delete.
 *
 * A COMPULSORY SERVICE CHARGE IS THE OPPOSITE. Added whether or not the customer agrees, it IS
 * consideration: part of the price, taxable at the meal's own rate, and it belongs INSIDE the
 * order total. IT MUST NOT BE RECORDED HERE. There is deliberately no `mandatory` flag, no
 * `kind`, and no venue setting on this path -- a row in `payment_tips` is a claim that the
 * payment was voluntary, and a compulsory charge recorded here would be untaxed consideration.
 *
 * IF A VENUE ASKS FOR A MANDATORY SERVICE CHARGE, THAT IS A SEPARATE FEATURE. It prices into the
 * order, through the pricing module, with its own VAT treatment. It is not a toggle on this one,
 * and a PR that adds such a toggle here is the thing this comment exists to stop.
 *
 * PROVENANCE, STATED HONESTLY: no NamRA guidance specific to gratuities was found. This follows
 * the GENERAL CONSIDERATION PRINCIPLE -- is the payment given in exchange for the supply? -- which
 * is the ordinary basis for the distinction, NOT a Namibian ruling on tips. A venue's own
 * accountant should confirm. If that advice contradicts this, change the design deliberately;
 * do not start writing service charges into these rows.
 *
 * ============================================================================================
 * NOT REVENUE
 * ============================================================================================
 *
 * `lib/reports/get-report-data.ts` derives `totalRevenue` from ORDERS. A tip is not a sale, so
 * leaving it off the order is also what keeps it out of the daily report -- again by construction.
 * Putting gratuities into a turnover figure is a deliberate change somebody has to ask for.
 *
 * ============================================================================================
 * WHOSE TIP
 * ============================================================================================
 *
 * THE SETTLER: the user the authorization token identified, who actually took the money. Not the
 * waiter who opened the table (`tabs.opened_by_user_id`). Ruled 2026-09-05. Pooling is a payroll
 * decision and is not modelled -- if a venue shares tips out, they share out what this reports.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Cash or card. A tip is taken by the same instrument as the bill it rode on. */
export type TipMethod = 'cash' | 'card'

export type TipCaptureInput = {
  restaurantId: string
  /** Integer cents, matching order_line_allocation_settlements. Never a float amount. */
  tipCents: number
  method: TipMethod
  /** The settler's users.id. Required: money with no name attached is what this prevents. */
  staffUserId: string
  tabId?: string | null
  /** The transaction this gratuity rode on. Required: both settle paths generate one per settle. */
  paymentReference: string
  /** Optional direct pointers to the money record. The reference above is the identity. */
  paymentId?: string | null
  allocationSettlementId?: string | null
}

export type TipParseResult =
  | { ok: true; tipCents: number }
  | { ok: false; code: TipRejectionCode; message: string }

export type TipRejectionCode =
  | 'TIP_NOT_A_NUMBER'
  | 'TIP_NOT_AN_INTEGER'
  | 'TIP_NEGATIVE'
  | 'TIP_TOO_LARGE'

/**
 * A ceiling, because a gratuity is a gift and a mis-keyed one is somebody's night.
 *
 * NAD 10,000.00. Chosen to be far above any plausible tip and far below a fat-finger that adds
 * two zeroes to a bill. It is a REFUSAL, not a clamp: silently capping would take a different
 * amount from the one the customer agreed to, which is worse than making the operator re-enter it.
 */
export const MAX_TIP_CENTS = 1_000_000

/**
 * Parses a client-supplied tip into integer cents, or refuses.
 *
 * ABSENT AND ZERO BOTH MEAN "NO TIP", and both yield `{ ok: true, tipCents: 0 }` -- the caller
 * then writes NO ROW. A zero-value row would be a record asserting a gratuity of nothing.
 *
 * The value is taken in CENTS from the caller rather than as a currency amount, deliberately: a
 * float `12.34` cannot be trusted to round to 1234 the same way everywhere, and this is money.
 */
export function parseTipCents(raw: unknown): TipParseResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, tipCents: 0 }

  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n)) {
    return { ok: false, code: 'TIP_NOT_A_NUMBER', message: 'Tip must be a number of cents.' }
  }
  if (!Number.isInteger(n)) {
    return {
      ok: false,
      code: 'TIP_NOT_AN_INTEGER',
      message: 'Tip must be whole cents — send 1250 for NAD 12.50, not 12.5.',
    }
  }
  if (n < 0) {
    return {
      ok: false,
      code: 'TIP_NEGATIVE',
      message: 'A tip cannot be negative. Reversing one is a refund, not a negative gratuity.',
    }
  }
  if (n > MAX_TIP_CENTS) {
    return {
      ok: false,
      code: 'TIP_TOO_LARGE',
      message: `Tip exceeds the ${MAX_TIP_CENTS / 100} limit. Re-enter it if that was intended.`,
    }
  }
  return { ok: true, tipCents: n }
}

export type TipRecordResult =
  | { recorded: true; id: string }
  | { recorded: false; reason: 'no_tip' }
  | { recorded: false; reason: 'duplicate' }
  | { recorded: false; reason: 'failed'; error: string }

/**
 * Writes one gratuity row, or explains why it did not.
 *
 * NEVER THROWS. It is called from a settle route AFTER the money has moved, and a failure to
 * record the tip must not turn a completed settlement into a 500 -- the customer has paid and the
 * table needs to turn. The caller reports the outcome; it does not abort on it.
 *
 * A DUPLICATE IS NOT AN ERROR. The unique indexes make one-tip-per-settlement a database
 * property, so a retried settle hits 23505 and is reported as `duplicate` rather than failing.
 * That is the desired behaviour: the tip is already recorded.
 */
export async function recordTip(
  supabase: SupabaseClient,
  input: TipCaptureInput,
): Promise<TipRecordResult> {
  if (input.tipCents <= 0) return { recorded: false, reason: 'no_tip' }

  if (!input.paymentReference) {
    return {
      recorded: false,
      reason: 'failed',
      error: 'a tip must name the transaction it rode on (payment_reference)',
    }
  }
  if (!input.staffUserId) {
    return { recorded: false, reason: 'failed', error: 'a tip must name the staff member who took it' }
  }

  const { data, error } = await supabase
    .from('payment_tips')
    .insert({
      restaurant_id: input.restaurantId,
      tip_cents: input.tipCents,
      method: input.method,
      staff_user_id: input.staffUserId,
      payment_reference: input.paymentReference,
      tab_id: input.tabId ?? null,
      payment_id: input.paymentId ?? null,
      allocation_settlement_id: input.allocationSettlementId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505' || String(error.message || '').includes('duplicate key')) {
      return { recorded: false, reason: 'duplicate' }
    }
    return { recorded: false, reason: 'failed', error: error.message }
  }
  return { recorded: true, id: String(data.id) }
}
