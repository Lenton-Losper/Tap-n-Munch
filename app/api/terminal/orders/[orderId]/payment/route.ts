import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
// canClose asks "does anything on this tab still owe money", which is what owesMoney answers.
// Asked in SQL as `.neq('payment_status', 'paid')` it also matched CANCELLED orders, so one
// cancelled order kept a table permanently un-closeable (#104, same class as c362efc).
import {
  SETTLEMENT_PAYMENT_METHODS,
  normalizeSettlementPaymentMethod, amountsMatch, owesMoney } from '@/lib/payments/payment-integrity'
import { recordPaymentAmountMismatch } from '@/lib/payments/record-amount-mismatch'
// The single authority on what the reader was asked to charge. See the note at its call site.
import { expectedChargeFor } from '@/lib/payments/expected-charge'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { handleTerminalPaymentFailed } from '@/lib/payments/handle-terminal-payment-failed'
import { recordRefusedSecondPayment } from '@/lib/payments/record-refused-second-payment'
import { clearReadyToPayAndReopenTab } from '@/lib/tabs/settle-tab-state'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    const body = await req.json().catch(() => ({}))
    const status = String(body?.status || '').trim()
    const reference = body?.reference != null ? String(body.reference).trim() : ''
    const voucherNo =
      body?.voucherNo != null && String(body.voucherNo).trim()
        ? String(body.voucherNo).trim()
        : ''
    const businessOrderNo =
      body?.businessOrderNo != null && String(body.businessOrderNo).trim()
        ? String(body.businessOrderNo).trim()
        : ''
    /**
     * The terminal's own classification of WHY the payment failed, and whether it can prove the
     * gateway was never contacted. Both are required for the verification bypass in
     * handleTerminalPaymentFailed — see TERMINAL_USER_CANCELLED_REASON.
     *
     * These were missing until 2026-08-10. The terminal had been sending both fields since vc80,
     * this handler read neither, and `body` is `any`, so nothing failed — the reason silently
     * defaulted to 'payment_declined' and the bypass could never fire. Staging order #79 is the
     * recorded case: the operator cancelled, the terminal classified it correctly, and the order
     * still went to Finatic, hit missing credentials, and was left pending.
     *
     * `=== true` deliberately, not a truthy check: the JSON string "false" is truthy.
     */
    const cancellationReason =
      body?.cancellationReason != null ? String(body.cancellationReason).trim() : ''
    const noGatewayAttempt = body?.noGatewayAttempt === true

    /**
     * ============================================================================================
     * THE RAW GATEWAY RESULT CODE — DIAGNOSTIC ONLY (D-4)
     * ============================================================================================
     *
     * The code WiseCashier returned in its `result` extra, e.g. "N002". The terminal shows it to
     * staff in the failure message and, until now, threw it away: an ambiguous outcome reports a
     * reference of `UNCONFIRMED-<epoch>`, which carries no code. Measured on staging, all 21 `sale`
     * rows in payment_events have gateway_result_code NULL, so the one value that would let anyone
     * count how often N002 happens was unrecoverable.
     *
     * IT MUST NEVER INFLUENCE PAYMENT CORRECTNESS. It IS passed to handleTerminalPaymentFailed —
     * that is how it reaches the audit trail — but nothing there, or anywhere else, branches on its
     * value. It is DIAGNOSTIC AND RECONCILIATION DATA ONLY: written into the audit metadata of
     * whichever outcome the call reaches, read by humans and by whoever later counts how often a
     * given code occurs. It must never decide paid vs not-paid, and must never authorise, block or
     * alter a cancellation.
     *
     * This is a device-asserted string. The moment a device assertion can steer paid/not-paid it
     * becomes a second `noGatewayAttempt` — a field a wrong or hostile client could use to skip
     * Finatic verification. `noGatewayAttempt` is only safe because it requires an exact second
     * value to agree with it; this field is given no such power because it needs none.
     *
     * OPTIONAL, AND ABSENT IS NORMAL. Every terminal build before this change sends nothing, and a
     * fielded APK may outlive several worker deploys. Absent must therefore mean "not reported",
     * never "empty string" — hence null rather than ''. Nothing branches on it either way.
     *
     * NOT PARSED OUT OF THE REFERENCE. The code travels in its own field; encoding it into
     * `reference` would mix an identifier with a diagnostic and is explicitly not done.
     */
    const gatewayResult =
      body?.gatewayResult != null && String(body.gatewayResult).trim()
        ? String(body.gatewayResult).trim().slice(0, 32)
        : null

    const amount = Number(body?.amount)
    /**
     * VALIDATED AGAINST THE SETTLEMENT ALLOWLIST, which it never was.
     *
     * This took `paymentMethod` as a FREE STRING and defaulted to 'card'. It flows straight to
     * orders.payment_method, which has no CHECK -- deliberately, because the QR path legitimately
     * writes hosted_checkout and friends there. So a typo from a terminal ('PayToday', 'paytodya')
     * persisted silently and surfaced in every report as its own unrecognised method, with the
     * money filed under a name nothing else knows.
     *
     * This is the TERMINAL leg, so the settlement allowlist is the right vocabulary: cash, card or
     * paytoday. Normalising also fixes case and whitespace, which matters because a stored
     * 'Cash' prints correctly on a receipt and reads as unknown everywhere else.
     *
     * Absent still means 'card' -- unchanged, because that is what every existing caller relies on.
     */
    const rawPaymentMethod = body?.paymentMethod
      ? String(body.paymentMethod).trim()
      : 'card'
    const paymentMethod = normalizeSettlementPaymentMethod(rawPaymentMethod)
    if (!paymentMethod) {
      return NextResponse.json(
        {
          error: 'Unsupported payment method',
          code: 'UNSUPPORTED_PAYMENT_METHOD',
          received: rawPaymentMethod,
          allowed: [...SETTLEMENT_PAYMENT_METHODS],
        },
        { status: 400 },
      )
    }

    if (status !== 'success' && status !== 'failed') {
      return NextResponse.json({ error: 'Invalid payment status' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        // payment_reference added 2026-08-24: the 409 ALREADY_PAID branch compares the reference
        // THIS attempt presents against the one the order already carries, and a different one
        // means a second gateway transaction rather than a repeated callback. Read here, before
        // the safety net below can write a merchant order number onto a row that had none.
        // pending_charge_cents / pending_tip_cents are SELECTED, not merely written. Without them
        // expectedChargeFor falls back to the order total on every row and the fix below ships
        // INERT -- the failure mode this project has shipped before.
        // The new columns go BEFORE payment_reference, not after. `refused-second-payment-trail`
        // asserts this select with /'id, tab_id[^']*payment_reference'/ -- an anchor that requires
        // payment_reference to be last. Appending past it broke a test about a different thing
        // entirely, which is a worse outcome than choosing an order.
        'id, tab_id, restaurant_id, status, total, payment_status, paycloud_merchant_order_no, pending_charge_cents, pending_tip_cents, payment_reference',
      )
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    let canClose = false

    if (status === 'success') {
      /**
       * ============================================================================================
       * WHAT THE READER WAS ASKED FOR, NOT WHAT THE ORDER TOTALS
       * ============================================================================================
       *
       * This was `Number(order.total)`. The gate is correct for an untipped charge and REFUSES A
       * PAYMENT THAT SUCCEEDED the moment a gratuity is included: prepare-payment records
       * `pending_charge_cents = items + tip` and returns that figure for the device to charge, and
       * the card has already been debited by the time this callback runs.
       *
       * It is the same defect lib/payments/expected-charge.ts was written to remove from the other
       * three gates in 2026-09-09. This route was not one of them -- the suite that pins it
       * (`whole-order-tip-expected-charge`) names verify-payment, the webhook and reconcile, and
       * this path was missed.
       *
       * IDENTICAL BEHAVIOUR FOR EVERY UNTIPPED ORDER. `expectedChargeFor` falls back to the order
       * total whenever no attempt recorded an expectation, which is every order that predates the
       * column and every path that does not prepare a charge. Zero tolerance is unchanged: the
       * figure being compared is corrected, the comparison is not loosened.
       *
       * THIS ROUTE IS SINGLE-ORDER BY DESIGN and stays that way. It is the device reporting the
       * outcome of ONE order's charge, so the verified set and the applied set are both `{orderId}`
       * and the Riviera shape is not available here. Expanding it to a settlement would change what
       * the endpoint means, not fix anything.
       */
      const charge = expectedChargeFor(order)
      const expectedAmount = charge.expectedAmount
      if (!amountsMatch(amount, expectedAmount)) {
        // The card has ALREADY been charged when this runs -- WiseCashier reported success.
        // Refusing is still right (the figures genuinely disagree), but leaving no trace is
        // not: the order stays pending and is later swept as auto_timeout or cancelled by hand
        // as "no charge found", indistinguishable from a genuine abandonment (#187). Records
        // the disagreement and never throws, so the 400 below is unaffected either way.
        await recordPaymentAmountMismatch(supabase, {
          restaurantId: terminal.restaurantId,
          orderId,
          expectedAmount,
          receivedAmount: Number.isFinite(amount) ? amount : null,
          source: 'terminal_callback',
          terminalId: terminal.terminalId,
          businessOrderNo: businessOrderNo || order.paycloud_merchant_order_no || null,
          reference: reference || null,
        })

        return NextResponse.json(
          {
            error: 'amount does not match order total',
            code: 'AMOUNT_MISMATCH',
            expected: expectedAmount,
            received: Number.isFinite(amount) ? amount : null,
          },
          { status: 400 },
        )
      }

      // Safety net: if prepare-payment was skipped (stale APK), persist merchant order now.
      if (businessOrderNo && !order.paycloud_merchant_order_no) {
        await supabase
          .from('orders')
          .update({ paycloud_merchant_order_no: businessOrderNo.slice(0, 32) })
          .eq('id', orderId)
          .eq('restaurant_id', terminal.restaurantId)
          .is('paycloud_merchant_order_no', null)
      }

      const result = await markOrderPaidConfirmed(supabase, {
        orderId,
        restaurantId: terminal.restaurantId,
        reference,
        voucherNo,
        paymentMethod,
        amount: expectedAmount,
        terminalId: terminal.terminalId,
        source: 'terminal_callback',
        extraAuditMetadata: {
          businessOrderNo: businessOrderNo || order.paycloud_merchant_order_no || null,
        },
      })

      if (!result.claimed) {
        /**
         * #329 follow-up, 2026-08-24. THIS BRANCH USED TO RETURN AND WRITE NOTHING.
         *
         * The refusal is correct and unchanged -- the atomic claim already stopped a second
         * `paid` write. What was missing is that this is the ONE MOMENT the server is told a
         * payment succeeded for an order that is already paid, and it recorded nothing at all.
         *
         * The card is charged on the DEVICE before this route is reached, so by now the money
         * has already moved. If the reference differs from the one the order carries, a second
         * gateway transaction exists and the customer has very likely been charged twice.
         * Refusing silently made that invisible; it is the only trace there will ever be.
         *
         * `order` is the row read BEFORE the merchant-order safety net above, so the comparison
         * cannot be corrupted by this attempt's own value landing on a row that had none.
         *
         * Best effort: the 409 is returned whatever this does.
         */
        await recordRefusedSecondPayment(supabase, {
          orderId,
          restaurantId: terminal.restaurantId,
          reason: result.reason,
          attemptedReference: reference || null,
          attemptedBusinessOrderNo: businessOrderNo || null,
          attemptedVoucherNo: voucherNo || null,
          existingReference: (order.payment_reference as string | null) ?? null,
          existingBusinessOrderNo: (order.paycloud_merchant_order_no as string | null) ?? null,
          orderTotal: Number(order.total ?? 0),
          amountClaimed: Number.isFinite(amount) ? amount : null,
          terminalId: terminal.terminalId,
          appVersion: typeof body?.app_version === 'string' ? body.app_version : null,
          source: 'terminal/orders/payment',
        })

        return NextResponse.json(
          {
            error: result.reason === 'already_paid' ? 'Order is already paid' : 'Order payment could not be claimed',
            code: result.reason === 'already_paid' ? 'ALREADY_PAID' : 'PAYMENT_CLAIM_CONFLICT',
          },
          { status: 409 },
        )
      }

      if (result.tabId) {
        const { data: remainingOrders } = await supabase
          .from('orders')
          .select('id, payment_status')
          .eq('tab_id', result.tabId)

        canClose = (remainingOrders ?? []).every((o) => !owesMoney(o.payment_status))

        await clearReadyToPayAndReopenTab(supabase, {
          tabId: result.tabId,
          logPrefix: '[terminal/orders/payment]',
          // Money was taken. #287: if this tab still owes, the ready-to-pay RECORD survives so the
          // other diners' request is not erased by the first person to pay.
          reason: 'money_taken',
        })
      }
    } else {
      // Never trust a terminal failure report alone when Finatic may already have
      // charged (order #635). Same verify-before-cancel pattern as autoCancelStalePosOrders.
      let failedResult
      try {
        failedResult = await handleTerminalPaymentFailed(
          supabase,
          {
            orderId,
            restaurantId: terminal.restaurantId,
            orderTotal: Number(order.total),
            paycloudMerchantOrderNo: order.paycloud_merchant_order_no,
            terminalId: terminal.terminalId,
            reference,
            amount: Number.isFinite(amount) ? amount : undefined,
            paymentMethod,
            // Pass the terminal's classification through UNCHANGED. handleTerminalPaymentFailed
            // does the exact-match check; this layer must not normalise, default or reword the
            // reason, or the match it performs is against a string we invented.
            ...(cancellationReason ? { cancellationReason } : {}),
            noGatewayAttempt,
            // D-4: recorded in the audit trail, never consulted. See the note where it is parsed.
            gatewayResult,
          },
          { stagingFinaticStub: body?.__stagingFinaticStub },
        )
      } catch (cancelErr: unknown) {
        const message = cancelErr instanceof Error ? cancelErr.message : 'Cancel failed'
        console.error('[terminal/payment] handleTerminalPaymentFailed error:', cancelErr)
        return NextResponse.json({ error: message }, { status: 500 })
      }

      if (failedResult.outcome === 'cancel_conflict') {
        return NextResponse.json(
          {
            error: 'Order payment could not be cancelled',
            code: 'PAYMENT_CANCEL_CONFLICT',
          },
          { status: 409 },
        )
      }

      if (failedResult.outcome === 'corrected_to_paid') {
        if (failedResult.tabId) {
          const { data: remainingOrders } = await supabase
            .from('orders')
            .select('id, payment_status')
            .eq('tab_id', failedResult.tabId)

          canClose = (remainingOrders ?? []).every((o) => !owesMoney(o.payment_status))

          await clearReadyToPayAndReopenTab(supabase, {
            tabId: failedResult.tabId,
            logPrefix: '[terminal/orders/payment:corrected_to_paid]',
            // Same as above: this branch corrects a false failure TO paid, so money was taken.
            reason: 'money_taken',
          })
        }

        return NextResponse.json({
          success: true,
          canClose,
          outcome: 'corrected_to_paid',
        })
      }

      if (failedResult.outcome === 'left_pending_finatic_uncertain') {
        /**
         * success: FALSE. This is the #868 root cause and it is not a cosmetic change.
         *
         * This branch used to answer `success: true` -- the same value returned for
         * `corrected_to_paid` (payment confirmed) and for `cancelled` (payment definitively not
         * taken). A client branching on `success`, which is the obvious thing to branch on, could
         * not tell paid from cancelled from unknown. On 2026-08-21 the reader reported order #868
         * as DECLINED, this route answered `success: true`, and N$33 of food was released on a
         * payment that never cleared.
         *
         * The operation did not succeed. The order is still `pending` and its payment state is
         * unknown, so the honest answer is false. `outcome` remains the precise discriminator;
         * `success` now merely stops contradicting it.
         *
         * FALSE RATHER THAN REMOVING THE FIELD, deliberately: every response from this route still
         * carries `success`, so the shape is unchanged and nothing destructuring it breaks. Removing
         * it would make `res.success` undefined, which reads falsy in the common case but differs
         * from `false` under `=== false` and in any typed client.
         *
         * THE OLD COMMENT HERE PROMISED THAT THE STALE-ORDER CRON WOULD RESOLVE THESE LATER. That
         * promise is false, and its being false is how this stayed invisible: auto-cancel-stale-pos-orders.ts
         * partitions on paycloud_merchant_order_no, and an order WITH a reference goes to the
         * Finatic branch, answers E04111, and is skipped on every run with no terminating
         * condition. Nothing resolves these today. See docs/design-persistence-pass-2026-08-21.md.
         */
        return NextResponse.json({
          success: false,
          canClose: false,
          outcome: 'left_pending_finatic_uncertain',
          reason: failedResult.reason,
        })
      }

      return NextResponse.json({
        success: true,
        canClose: false,
        outcome: 'cancelled',
      })
    }

    return NextResponse.json({ success: true, canClose })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
