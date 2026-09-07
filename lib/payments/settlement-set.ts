/**
 * EXPAND A LEAD ORDER TO THE WHOLE SETTLEMENT IT BELONGS TO.
 *
 * ==================================================================================================
 * WHY THIS EXISTS
 * ==================================================================================================
 *
 * `orders.paycloud_merchant_order_no` is minted on ONE row per payment -- the lead order -- and a
 * unique partial index enforces that. So every path that resolves a gateway reference back to our
 * side gets exactly one order, however many were charged:
 *
 *   verify-payment    called with orderIds[0]
 *   paycloud webhook  resolver leg 1 matches the lead row
 *
 * Each then compared the WHOLE gateway amount against ONE order's expectation and refused a
 * payment that had succeeded. `pending_settlement_id` records which rows are the same charge; this
 * turns that into the row set the expectation is summed over.
 *
 * ==================================================================================================
 * IT FAILS TOWARDS TODAY'S BEHAVIOUR, ALWAYS
 * ==================================================================================================
 *
 * A NULL settlement id, a read that errors, or a lookup that returns nothing all yield THE LEAD
 * ORDER ALONE -- which is precisely what these gates did before this existed. Every order on
 * production today has NULL here, so nothing changes for them.
 *
 * That direction is deliberate. Expanding wrongly would make a gate expect MORE than was charged
 * and refuse a real payment; failing to expand reproduces a defect that is already understood and
 * already fail-safe (neither gate marks an order paid on a mismatch).
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { EXPECTED_CHARGE_COLUMNS, type ChargeExpectationRow } from '@/lib/payments/expected-charge'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** What the gates need off each row: the charge columns, plus the id to keep the set honest. */
export const SETTLEMENT_SET_COLUMNS = `id, pending_settlement_id, ${EXPECTED_CHARGE_COLUMNS}`

export type SettlementOrderRow = ChargeExpectationRow & {
  id?: unknown
  pending_settlement_id?: unknown
}

export type SettlementSet = {
  /** Every order in the charge, ALWAYS including the lead order. */
  orders: SettlementOrderRow[]
  /** How the set was arrived at, so a refusal can say which rule produced its expectation. */
  basis: 'settlement_id' | 'lead_order_only'
  settlementId: string | null
}

/**
 * Every order sharing this order's settlement id, including itself.
 *
 * `restaurantId` is not optional and is applied to the lookup: a settlement id is a uuid and
 * collisions are not a realistic worry, but a cross-venue read on the money path is not something
 * to leave to probability.
 */
export async function settlementSetFor(
  supabase: Supabase,
  leadOrder: SettlementOrderRow,
  restaurantId: string,
): Promise<SettlementSet> {
  const settlementId = String(leadOrder?.pending_settlement_id ?? '').trim() || null

  // No settlement recorded -- every order that predates this column, and every path that does not
  // prepare a charge. Today's behaviour, exactly.
  if (!settlementId) {
    return { orders: [leadOrder], basis: 'lead_order_only', settlementId: null }
  }

  const { data, error } = await supabase
    .from('orders')
    .select(SETTLEMENT_SET_COLUMNS)
    .eq('pending_settlement_id', settlementId)
    .eq('restaurant_id', restaurantId)

  if (error) {
    /**
     * FALL BACK, DO NOT THROW. The caller is mid-verification of a payment the gateway says
     * succeeded; refusing outright over a failed read would strand an order for a reason unrelated
     * to the money. The lead order alone is the pre-existing behaviour and is fail-safe.
     */
    console.error('[settlementSetFor] could not expand the settlement', {
      settlementId,
      error: error.message,
    })
    return { orders: [leadOrder], basis: 'lead_order_only', settlementId }
  }

  const rows = (data ?? []) as SettlementOrderRow[]
  if (rows.length === 0) {
    return { orders: [leadOrder], basis: 'lead_order_only', settlementId }
  }

  /**
   * THE LEAD ORDER IS GUARANTEED PRESENT. The query should return it -- it carries the id we looked
   * up -- but if a concurrent prepare cleared it mid-flight, dropping it would make the expectation
   * SMALLER than what was charged. Re-added rather than assumed.
   */
  const leadId = String(leadOrder?.id ?? '')
  const haveLead = rows.some((r) => String(r.id ?? '') === leadId)
  const orders = haveLead || !leadId ? rows : [...rows, leadOrder]

  return { orders, basis: 'settlement_id', settlementId }
}
