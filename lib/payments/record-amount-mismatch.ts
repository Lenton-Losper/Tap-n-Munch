import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * Where the mismatch was detected. Both are AFTER the card was charged -- that is the whole
 * reason this record exists.
 *
 * 'terminal_callback'      POST /api/terminal/orders/[orderId]/payment, status='success'.
 *                          WiseCashier has returned a successful charge and the server refuses
 *                          it with a 400.
 * 'terminal_verify_payment' POST /api/terminal/orders/[orderId]/verify-payment. Finatic has
 *                          said the order was PAID, for a figure that disagrees.
 * 'paycloud_webhook'       #223. POST /api/webhooks/paycloud, either the signature-valid path
 *                          (payload claims paid) or the signature-fallback path (independent
 *                          Finatic order.query). Both charged the customer before this fires.
 * 'reconcile_orphan_payments' #223. lib/payments/reconcile-orphan-payments.ts, matching a
 *                          payment_events 'sale' row against the orders it names.
 *
 * The third amountsMatch call site, tabs/[tabId]/settle, is deliberately absent: it compares
 * BEFORE taking the money (see the "Verify the attribution before taking the money" comment
 * immediately below its guard), so its 400 refuses a payment that never happened. Nothing was
 * charged and there is nothing to reconcile. app/api/payments/receipt/route.ts is the same
 * shape -- it validates a client-submitted amount before creating the PayCloud checkout, not
 * after a gateway confirmation -- so it is absent for the same reason.
 */
export type AmountMismatchSource =
  | 'terminal_callback'
  | 'terminal_verify_payment'
  | 'paycloud_webhook'
  | 'reconcile_orphan_payments'

export type RecordAmountMismatchParams = {
  restaurantId: string
  orderId: string
  /** The server's figure -- the order total, or the sum of a tab's order totals. */
  expectedAmount: number
  /** What the terminal or gateway reported. Null when it was absent or unparseable. */
  receivedAmount: number | null
  source: AmountMismatchSource
  terminalId?: string | null
  businessOrderNo?: string | null
  reference?: string | null
}

/**
 * Leave a durable trace when a payment amount mismatch is refused AFTER the card was charged.
 *
 * WHAT THIS DOES NOT DO. It does not mark anything paid, does not change the HTTP status, does
 * not change what the terminal is told, and does not change the order's state. #187 proposes
 * that a charged-but-mismatched payment should instead be recorded as paid with a warning; that
 * is a decision about what a payment MEANS and it is not taken here. The neighbouring path has
 * already rejected the closely-related version of it -- handle-terminal-payment-failed.ts:179-183
 * refuses to "correct to paid using the order total" precisely because a mis-correlated
 * reference would mark THIS order paid on somebody else's money. This function changes nothing
 * about the money; it only stops the event being invisible.
 *
 * WHY IT IS NEEDED. #187's actual complaint is not that the 400 is wrong -- it is that
 * "nothing in the record distinguishes it from a genuine abandonment". That was true: the
 * order stays pending, no payment_events SALE row is written, and it is later swept as
 * auto_timeout or cancelled by hand as "no charge found". At payment/route.ts the refusal
 * wrote nothing at all, not even a log line. At verify-payment/route.ts it wrote a
 * console.error, which is ephemeral and cannot be queried when someone is reconciling a
 * disputed charge days later.
 *
 * The failure path already models this exact situation properly: a
 * `payment.verification_uncertain` audit row carrying BOTH figures, so the disagreement can be
 * settled from the row alone. This is that precedent applied to the success path. A distinct
 * action name rather than reusing that one, because the question an operator asks is different
 * -- "did the terminal and the server disagree about a charge that happened" is not "did
 * Finatic and the server disagree during verification" -- and overloading the existing value
 * would silently change what any query filtering on it returns.
 *
 * NEVER THROWS, AND NEVER CHANGES THE OUTCOME. Both call sites are on a path where the customer
 * has already been charged, so a failed audit insert must not turn a clean 400 into a 500 in
 * the generic catch: that would replace a specific, actionable error with a generic one and
 * make the situation strictly harder to diagnose. The insert failing is itself logged and
 * reported in the return value, and the caller proceeds either way.
 *
 * `audit_logs.action` is free text (`"action" "text" NOT NULL`, baseline.sql:224) with no CHECK
 * constraint, so the new value needs no migration.
 */
export async function recordPaymentAmountMismatch(
  supabase: Supabase,
  params: RecordAmountMismatchParams,
): Promise<{ recorded: boolean; error?: string }> {
  const reason =
    `Terminal reported a successful payment of ${params.receivedAmount ?? 'an unreadable amount'} ` +
    `for an order totalling ${params.expectedAmount}. Refused and left pending — the card may ` +
    `already have been charged, so this order needs reconciliation rather than cancellation.`

  console.error(`[recordPaymentAmountMismatch] order ${params.orderId}: ${reason}`)

  try {
    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: params.restaurantId,
      action: 'payment.amount_mismatch',
      entity_type: 'order',
      entity_id: params.orderId,
      metadata: {
        reason,
        // Both figures, so the disagreement is settleable from the audit row alone -- the same
        // convention as payment.verification_uncertain.
        expectedAmount: params.expectedAmount,
        receivedAmount: params.receivedAmount,
        source: params.source,
        terminalId: params.terminalId ?? null,
        businessOrderNo: params.businessOrderNo ?? null,
        reference: params.reference ?? null,
        // Names what actually happened to the order, so this is not mistaken for a record of a
        // payment that was accepted.
        outcome: 'refused_left_pending',
      },
    })

    if (error) {
      console.error(
        `[recordPaymentAmountMismatch] order ${params.orderId}: audit insert failed: ${error.message}`,
      )
      return { recorded: false, error: error.message }
    }

    return { recorded: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `[recordPaymentAmountMismatch] order ${params.orderId}: audit insert threw: ${message}`,
    )
    return { recorded: false, error: message }
  }
}
