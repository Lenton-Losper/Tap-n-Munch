/**
 * THE PAYMENT-INTENT TARGET SET — verified and applied are the SAME object, by construction.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO MAKE UNREPRESENTABLE
 * ==================================================================================================
 *
 * Riviera, 2026-09-18 16:37 UTC, settlement 4158ff51-2468-4bdf-a8d0-57947ab173dc:
 *
 *   orders #154 (N$220) and #155 (N$500) were one charge of N$720
 *   the gateway confirmed N$720
 *   the webhook VERIFIED N$720 against both orders   -- correct
 *   the webhook APPLIED payment to #155 only         -- wrong
 *   #154 is still unpaid, and audit_logs records "gatewayAmount: 720" on the N$500 order
 *
 * `app/api/webhooks/paycloud/route.ts` at 3a58efce built two lists and used the wrong one twice:
 *
 *   line 201   settlementRows = expanded set          [#155, #154]
 *   line 203   expectedAmount = sum(settlementRows)   N$720   <- VERIFIED against this
 *   line 290   singleOrderSettlement = orderRows.length === 1   <- true, because orderRows is [#155]
 *   line 302   for (const row of orderRows)           [#155]  <- APPLIED to this
 *
 * The same shape sits in `verify-payment/route.ts`: line 279 expands to the settlement set to
 * compute `expectedAmount`, line 378 calls `markOrderPaidConfirmed` with the single `orderId` from
 * the URL.
 *
 * ==================================================================================================
 * THE FIX IS STRUCTURAL, NOT A SUBSTITUTION
 * ==================================================================================================
 *
 * Replacing `orderRows` with `settlementRows` in that loop would fix this instance and leave the
 * defect's *shape* intact: two lists in scope, either of which type-checks in either position.
 *
 * So there are no longer two lists. `resolveSettlementTarget` returns ONE `SettlementTarget` whose
 * `orders` is the only order collection in scope, and `expectedAmountCents` is computed from that
 * same array at the moment it is built. The settlement RPC is then handed the TARGET — not an id
 * list assembled separately — and derives both what to check and what to write from it inside one
 * transaction.
 *
 * There is deliberately no exported way to obtain the expected amount without the set it was summed
 * over, and no exported way to obtain an id list that is not the set that was verified.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { EXPECTED_CHARGE_COLUMNS, expectedChargeForOrders } from '@/lib/payments/expected-charge'
import type { PaymentIntent } from '@/lib/payments/payment-intents'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type TargetOrderRow = {
  id: string
  restaurant_id: string
  tab_id: string | null
  total: unknown
  payment_status: unknown
  payment_method: unknown
  cancellation_reason: unknown
  cancelled_at: unknown
  pending_charge_cents: unknown
  pending_tip_cents: unknown
  pending_settlement_id: unknown
}

/** Everything a target row must carry. `id` is included so the set can never be summed blind. */
export const TARGET_ORDER_COLUMNS =
  `id, restaurant_id, tab_id, payment_status, payment_method, cancellation_reason, cancelled_at, ` +
  `pending_settlement_id, ${EXPECTED_CHARGE_COLUMNS}`

/**
 * How the target set was arrived at. Carried into the audit trail so a settlement can always say
 * which rule produced the rows it paid — the thing that was impossible to answer for Riviera.
 */
export type TargetBasis =
  /** An `orders`-scope payment intent named these ids explicitly. The strongest basis. */
  | 'intent'
  /** `orders.pending_settlement_id` grouped them. Written by prepare-payment. */
  | 'settlement_id'
  /** No grouping exists — one order, the pre-2026-09 behaviour and every legacy reference. */
  | 'lead_order_only'

export type SettlementTarget = {
  /** THE orders. The only order collection in scope; both verified and applied. */
  readonly orders: readonly TargetOrderRow[]
  /** Their ids, derived from `orders` and never assembled separately. */
  readonly orderIds: readonly string[]
  /** Summed over `orders` at construction. In integer cents — never a currency float. */
  readonly expectedAmountCents: number
  /** Major units, for the existing `amountsMatch` gates. Same number, one division. */
  readonly expectedAmount: number
  /** Gratuity inside expectedAmountCents. */
  readonly tipCents: number
  readonly basis: TargetBasis
  readonly settlementId: string | null
  readonly intentId: string | null
  readonly restaurantId: string
}

function buildTarget(
  orders: TargetOrderRow[],
  meta: { basis: TargetBasis; settlementId: string | null; intentId: string | null },
): SettlementTarget {
  const charge = expectedChargeForOrders(orders)
  const cents = Math.round(charge.expectedAmount * 100)
  return {
    orders,
    orderIds: orders.map((o) => String(o.id)),
    expectedAmountCents: cents,
    expectedAmount: cents / 100,
    tipCents: charge.tipCents,
    basis: meta.basis,
    settlementId: meta.settlementId,
    intentId: meta.intentId,
    restaurantId: String(orders[0]?.restaurant_id ?? ''),
  }
}

async function loadOrders(
  supabase: Supabase,
  restaurantId: string,
  ids: string[],
): Promise<TargetOrderRow[] | null> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('orders')
    .select(TARGET_ORDER_COLUMNS)
    .in('id', ids)
    .eq('restaurant_id', restaurantId)
  if (error) {
    console.error('[resolveSettlementTarget] order read failed', { error: error.message })
    return null
  }
  return (data ?? []) as unknown as TargetOrderRow[]
}

export type ResolveTargetResult =
  | { ok: true; target: SettlementTarget }
  | { ok: false; reason: 'read_failed' | 'not_found' | 'incomplete' }

/**
 * Resolve the immutable target set for a whole-order card charge.
 *
 * PRECEDENCE, strongest first:
 *
 *   1. AN `orders`-SCOPE INTENT. It named the exact ids before the reader was launched, so it is
 *      the definition of what is being paid for. Every id it names must be readable — a partial
 *      read is `incomplete`, never a smaller target, because a smaller target is precisely the
 *      Riviera failure.
 *
 *   2. `pending_settlement_id`. Written by prepare-payment across the participating orders for
 *      clients that predate intents on this path. Same completeness rule.
 *
 *   3. THE LEAD ORDERS ALONE. Every legacy reference and every order placed before either column
 *      existed. Identical to the behaviour that shipped, which is what makes this safe to deploy
 *      ahead of any caller.
 *
 * FAILS CLOSED at every unknown. A read that errors returns `read_failed` rather than a shorter
 * set: not being able to see the whole settlement is not permission to settle part of it.
 */
export async function resolveSettlementTarget(
  supabase: Supabase,
  params: {
    restaurantId: string
    /** The order ids a resolver found — typically the lead order alone. */
    leadOrderIds: string[]
    /** The intent the reference resolved to, when there is one. */
    intent?: PaymentIntent | null
  },
): Promise<ResolveTargetResult> {
  const { restaurantId, leadOrderIds, intent } = params

  // ---- 1. an orders-scope intent defines the target outright -------------------------------
  if (intent && intent.scope === 'orders' && intent.orderIds.length > 0) {
    const rows = await loadOrders(supabase, intent.restaurantId, intent.orderIds)
    if (rows === null) return { ok: false, reason: 'read_failed' }
    if (rows.length !== intent.orderIds.length) {
      console.error('[resolveSettlementTarget] intent names orders that could not be read', {
        intentId: intent.id,
        named: intent.orderIds.length,
        read: rows.length,
      })
      return { ok: false, reason: 'incomplete' }
    }
    return {
      ok: true,
      target: buildTarget(rows, {
        basis: 'intent',
        settlementId: String(rows[0]?.pending_settlement_id ?? '') || null,
        intentId: intent.id,
      }),
    }
  }

  // ---- 2/3. expand the lead orders through pending_settlement_id ----------------------------
  const leads = await loadOrders(supabase, restaurantId, leadOrderIds)
  if (leads === null) return { ok: false, reason: 'read_failed' }
  if (leads.length === 0) return { ok: false, reason: 'not_found' }

  const settlementIds = [
    ...new Set(
      leads
        .map((o) => String(o.pending_settlement_id ?? '').trim())
        .filter((s) => s.length > 0),
    ),
  ]

  if (settlementIds.length === 0) {
    return {
      ok: true,
      target: buildTarget(leads, {
        basis: 'lead_order_only',
        settlementId: null,
        intentId: null,
      }),
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .select(TARGET_ORDER_COLUMNS)
    .in('pending_settlement_id', settlementIds)
    .eq('restaurant_id', restaurantId)

  if (error) {
    /**
     * FAILS CLOSED, AND THAT IS A CHANGE FROM `settlementSetFor`.
     *
     * The old helper fell back to the lead order on a failed read, reasoning that the lead order
     * alone was the pre-existing behaviour and therefore fail-safe. Once the same set is what gets
     * WRITTEN, that reasoning inverts: falling back would apply the payment to a strict subset of
     * what the customer was charged for, which is the Riviera outcome arrived at deliberately.
     *
     * A refusal here leaves the orders exactly as they were, with the charge recorded and visible
     * for the retry or the human — nothing is lost, and nothing is half-applied.
     */
    console.error('[resolveSettlementTarget] settlement expansion failed', {
      settlementIds,
      error: error.message,
    })
    return { ok: false, reason: 'read_failed' }
  }

  const expanded = new Map<string, TargetOrderRow>()
  for (const row of leads) expanded.set(String(row.id), row)
  for (const row of (data ?? []) as unknown as TargetOrderRow[]) {
    expanded.set(String(row.id), row)
  }

  const orders = [...expanded.values()]
  return {
    ok: true,
    target: buildTarget(orders, {
      basis: orders.length > leads.length || settlementIds.length > 0 ? 'settlement_id' : 'lead_order_only',
      settlementId: settlementIds[0] ?? null,
      intentId: null,
    }),
  }
}

/**
 * Does the gateway's figure agree with what this target says was charged?
 *
 * EXACT, at GATEWAY_AMOUNT_TOLERANCE_CENTS = 0, and ABSENT IS NOT AGREEING. Both rules are carried
 * over unchanged from the gates this replaces; what changes is only that the figure on the right
 * of the comparison provably came from the rows that are about to be written.
 */
export function gatewayAmountAgrees(
  target: SettlementTarget,
  gatewayAmountMajorUnits: number | null | undefined,
): boolean {
  if (gatewayAmountMajorUnits === null || gatewayAmountMajorUnits === undefined) return false
  const n = Number(gatewayAmountMajorUnits)
  if (!Number.isFinite(n)) return false
  return Math.round(n * 100) === target.expectedAmountCents
}

/**
 * The audit figures for a settlement, named for WHAT THEY ARE (F15).
 *
 * The defect being closed: Riviera recorded `gatewayAmount: 720` on order #155, whose total is
 * N$500, because the code asked "is this a single-order settlement?" of the wrong array. A
 * per-order row may only carry a per-order figure.
 *
 * So the settlement-level numbers are always recorded under settlement-level names, and
 * `perOrderGatewayAmount` is non-null ONLY when the settlement genuinely is one order — in which
 * case the two figures are the same number and saying so costs nothing.
 */
export function settlementAuditFigures(
  target: SettlementTarget,
  gatewayAmountMajorUnits: number | null,
): {
  settlementGatewayAmount: number | null
  settlementExpectedAmount: number
  settlementOrderCount: number
  settlementOrderIds: string[]
  settlementBasis: TargetBasis
  perOrderGatewayAmount: number | null
} {
  const single = target.orders.length === 1
  return {
    settlementGatewayAmount: gatewayAmountMajorUnits,
    settlementExpectedAmount: target.expectedAmount,
    settlementOrderCount: target.orders.length,
    settlementOrderIds: [...target.orderIds],
    settlementBasis: target.basis,
    perOrderGatewayAmount: single ? gatewayAmountMajorUnits : null,
  }
}
