/**
 * THE SERVER-SIDE PAYMENT LEDGER ROW (F2).
 *
 * ==================================================================================================
 * THE GAP THIS CLOSES, MEASURED
 * ==================================================================================================
 *
 * Production, read-only on 2026-09-19: 1,630 orders are `payment_status = 'paid'` with
 * `payment_method = 'card'` and have NO `payment_events` sale row. N$110,027 of card-referenced
 * revenue with nothing in the ledger that says the money arrived.
 *
 * The cause is not a bug in any one place -- it is the architecture. The only writer of a sale row
 * is the DEVICE, after the fact, and it does not wait for the answer.
 * `src/screens/TableDetailScreen.tsx` at terminal 9426f990:
 *
 *     if (businessOrderNo && transactionId) {
 *       recordSaleEvent({...}, token).then(saleRecord => {
 *         if (!saleRecord.ok) console.warn('[TableDetail] recordSaleEvent failed:', ...)
 *       })
 *     } else {
 *       console.warn('[TableDetail] Skipping recordSaleEvent - missing businessOrderNo or voucherNo')
 *     }
 *
 * Not awaited, never retried, and skipped outright when either value is missing. A killed app, a
 * dropped connection, a reader that returned no voucher number -- each silently costs a ledger row,
 * and the settlement has already succeeded by then so nothing downstream notices.
 *
 * `PaymentScreen.tsx` has the identical shape.
 *
 * ==================================================================================================
 * ONE LEDGER, NOT TWO
 * ==================================================================================================
 *
 * This writes the SAME TABLE and the SAME idempotency key (`business_order_no`) the device writes.
 * When the device's call does arrive it hits the existing unique constraint, takes the 23505 branch
 * in `app/api/terminal/payment-events/sale/route.ts`, compares `order_ids` and `amount` against
 * this row and returns it. So the device keeps working unchanged, and F2's "do not create two
 * competing ledger systems" is satisfied by there being exactly one.
 *
 * `settle_order_payment` writes its ledger row inside the settlement transaction, which is
 * strictly better. This exists for the path that does NOT go through that function -- the terminal
 * tab settle, where the device has already charged the card and is reporting it -- so that path
 * stops depending on a fire-and-forget call for its only record of the money.
 *
 * ==================================================================================================
 * IT NEVER THROWS
 * ==================================================================================================
 *
 * Every caller reaches this AFTER the money has moved and the orders are already paid. A throw
 * would land in a route's outer catch and answer an auth error for a settlement that succeeded --
 * the failure mode `app/api/terminal/tabs/[tabId]/settle/route.ts` documents at length for its own
 * post-payment writes. The outcome is returned instead, so a caller can surface it the way
 * `payment_record_written` already is.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type RecordGatewaySaleResult = {
  /** True when THIS call inserted the row. */
  written: boolean
  outcome:
    /** Inserted here. */
    | 'recorded'
    /** A row already existed for this reference — the device won the race, or a retry. */
    | 'already_recorded'
    /** No gateway reference, so there is nothing a ledger row could be keyed on. */
    | 'skipped_no_reference'
    /** The insert failed for a real reason. Visible, not silent. */
    | 'failed'
  error?: string
}

export async function recordGatewaySaleEvent(
  supabase: Supabase,
  params: {
    restaurantId: string
    /** Every order this one transaction paid for. */
    orderIds: string[]
    /** The gateway reference (businessOrderNo). The ledger's idempotency key. */
    businessOrderNo: string | null
    /** The gateway's transaction id, when the reader returned one. */
    transactionId?: string | null
    /** THE AMOUNT COLLECTED, in major units. The server's figure, never the client's. */
    amount: number
    currency?: string
    terminalId?: string | null
    appVersion?: string | null
    /** Caller tag, recorded in raw_gateway_response so a row's provenance is readable. */
    source: string
  },
): Promise<RecordGatewaySaleResult> {
  const reference = String(params.businessOrderNo ?? '').trim()
  if (!reference) {
    /**
     * NOT AN ERROR, AND NOT INVENTED EITHER. `payment_events.business_order_no` is the value
     * reconciliation correlates against Finatic; a made-up one would produce a ledger row that
     * matches no gateway transaction, which is worse than the gap because it looks reconciled.
     * The caller surfaces this, and the order is discoverable through the
     * card-payments-without-merchant-reference report instead (F17).
     */
    return { written: false, outcome: 'skipped_no_reference' }
  }

  const orderIds = [...new Set((params.orderIds ?? []).map((id) => String(id).trim()).filter(Boolean))]
  if (orderIds.length === 0) return { written: false, outcome: 'skipped_no_reference' }

  const amount = Number(params.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { written: false, outcome: 'failed', error: 'amount must be a positive number' }
  }

  const transactionId = String(params.transactionId ?? '').trim() || null

  /**
   * THE THROW IS CAUGHT HERE, and the docblock's "it never throws" depends on it.
   *
   * A rejected insert -- a dropped socket, an aborted Worker fetch -- is not returned as `error`,
   * it is thrown. Letting that escape would land in the calling route's outer catch, which answers
   * `401 Unauthorized` for a settlement that has already succeeded and invites a retry against
   * orders that are already claimed. That is the exact failure the settle route's own header warns
   * about for its post-payment writes.
   */
  let error: { code?: string; message?: string } | null = null
  try {
    const res = await supabase.from('payment_events').insert({
      restaurant_id: params.restaurantId,
      order_ids: orderIds,
      event_type: 'sale',
      business_order_no: reference,
      origin_business_order_no: reference,
      transaction_id: transactionId,
      terminal_id: params.terminalId ?? null,
      app_version: params.appVersion ?? null,
      amount,
      currency: params.currency ?? 'NAD',
      // The SAME key the device uses, which is what makes the two writers one ledger, not two.
      idempotency_key: reference,
      initiated_by: null,
      reason_code: 'sale',
      raw_gateway_response: {
        recorded_by: 'server',
        source: params.source,
      },
    })
    error = res.error
  } catch (thrown) {
    error = {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    }
  }

  if (!error) return { written: true, outcome: 'recorded' }

  /**
   * 23505 IS THE SUCCESS CASE, not a failure: a row for this reference already exists, which is
   * the whole point of the idempotency key. Either the device got there first or this is a retry.
   *
   * Two constraints can raise it and both mean the same thing here -- the unique key on
   * (restaurant_id, idempotency_key) and, since 2026-09-19, the one on
   * (restaurant_id, transaction_id). The second catches the case where a retry arrives under a
   * different reference but the same gateway transaction, which is a duplicate the first one would
   * have missed.
   */
  if (error.code === '23505' || String(error.message ?? '').includes('duplicate key')) {
    return { written: false, outcome: 'already_recorded' }
  }

  console.error(`[recordGatewaySaleEvent:${params.source}] ledger insert failed`, {
    restaurantId: params.restaurantId,
    businessOrderNo: reference,
    orderIds,
    amount,
    error: error.message,
  })
  return { written: false, outcome: 'failed', error: error.message }
}
