import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
// canClose asks "does anything on this tab still owe money", which is what owesMoney answers.
// Asked in SQL as `.neq('payment_status', 'paid')` it also matched CANCELLED orders, so one
// cancelled order kept a table permanently un-closeable (#104, same class as c362efc).
import { amountsMatch, owesMoney } from '@/lib/payments/payment-integrity'
import { recordPaymentAmountMismatch } from '@/lib/payments/record-amount-mismatch'
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

    const amount = Number(body?.amount)
    const paymentMethod = body?.paymentMethod
      ? String(body.paymentMethod).trim()
      : 'card'

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
        'id, tab_id, restaurant_id, status, total, payment_status, paycloud_merchant_order_no, payment_reference',
      )
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    let canClose = false

    if (status === 'success') {
      const expectedAmount = Number(order.total)
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
        paymentMethod: paymentMethod || 'card',
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
            paymentMethod: paymentMethod || 'card',
            // Pass the terminal's classification through UNCHANGED. handleTerminalPaymentFailed
            // does the exact-match check; this layer must not normalise, default or reword the
            // reason, or the match it performs is against a string we invented.
            ...(cancellationReason ? { cancellationReason } : {}),
            noGatewayAttempt,
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
