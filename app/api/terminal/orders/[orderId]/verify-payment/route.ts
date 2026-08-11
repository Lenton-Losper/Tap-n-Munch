import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { queryFinaticOrderPaid } from '@/lib/payments/query-finatic-order-paid'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Terminal-auth Finatic status check for an order that already has
 * paycloud_merchant_order_no (from prepare-payment).
 *
 * When Finatic confirms paid=true, applies the correction immediately via the same
 * markOrderPaidConfirmed() used by the terminal's own success callback -- relying on
 * the terminal to separately call completePayment(success) afterward reproduces the
 * exact class of bug this route exists to catch (a device-side callback that never
 * arrives or misreports). Idempotent/safe if the terminal's own callback does still
 * land afterward: the second claim attempt just finds payment_status already 'paid'
 * and no-ops.
 *
 * Used when the device callback is missing, ambiguous, or reports failure after a
 * possible successful charge (false-failure / silence incidents).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, restaurant_id, payment_status, total, paycloud_merchant_order_no')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (orderError) {
      console.error('[terminal/verify-payment] load order failed', orderError)
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      return NextResponse.json({
        ok: true,
        paid: true,
        source: 'supabase',
        merchantOrderNo: order.paycloud_merchant_order_no
          ? String(order.paycloud_merchant_order_no)
          : null,
        transactionId: null,
        status: 'paid',
      })
    }

    const merchantOrderNo = String(order.paycloud_merchant_order_no || '').trim()
    if (!merchantOrderNo) {
      return NextResponse.json(
        {
          ok: true,
          paid: false,
          source: 'none',
          status: 'no_merchant_order',
          merchantOrderNo: null,
          transactionId: null,
          error: 'Order has no paycloud_merchant_order_no — prepare-payment was not completed',
        },
        { status: 200 },
      )
    }

    const { merchantNo, storeNo } = await getRestaurantFinaticCredentials(
      terminal.restaurantId,
    )

    const result = await queryFinaticOrderPaid({
      merchantOrderNo,
      merchantNo,
      storeNo,
    })

    console.log('[terminal/verify-payment]', {
      orderId,
      terminalId: terminal.terminalId,
      merchantOrderNo,
      paid: result.paid,
      status: result.status,
      transactionId: result.transactionId,
    })

    const expectedAmount = Number(order.total)
    let applied = false
    let outcome: string | null = null

    if (result.paid) {
      /**
       * #190. Two refusals, both of which leave a customer whose card HAS been charged with an
       * order that stays unpaid until staff intervene — so each one must leave a record, not a
       * log line. A console.error in a Worker is not a record.
       *
       * EXACT agreement, not the client tolerance. Finatic is echoing back our own figure
       * (push-to-terminal sends Number(order.total) as order_amount; expectedAmount is
       * Number(order.total) again), so a cent of daylight means the reference correlated to a
       * different sale — see GATEWAY_AMOUNT_TOLERANCE_CENTS.
       *
       * An ABSENT amount is UNVERIFIED, not agreed. `result.amount != null && !amountsMatch(...)`
       * previously short-circuited and applied the payment with no amount check of any kind, and
       * nothing in the response or the logs afterwards could distinguish "checked and agreed"
       * from "never checked". queryFinaticOrderPaid normalises through toMoney, so null here
       * means the field was genuinely absent or unparseable — not merely oddly formatted.
       *
       * Neither refusal cancels: Finatic has just said the customer was charged. The order is
       * left claimable for the reconcile cron or a human, which is what
       * payment.verification_uncertain already models on the sibling gateway leg in
       * handle-terminal-payment-failed.ts — and what the E04111 resolution procedure keys off.
       */
      const gatewayAmount = result.amount
      const verified =
        gatewayAmount != null &&
        amountsMatch(gatewayAmount, expectedAmount, GATEWAY_AMOUNT_TOLERANCE_CENTS)

      if (!verified) {
        const reason =
          gatewayAmount == null
            ? `Finatic reports paid but returned no amount for ${merchantOrderNo} — the amount was ` +
              'never verified, so the correction is not applied and the order is left claimable.'
            : `Finatic reports paid but for ${gatewayAmount}, not the order total ${expectedAmount} — ` +
              'not applying, and not cancelling an order the gateway says was charged.'
        console.error(`[terminal/verify-payment] order ${orderId}: ${reason}`)

        const { error: uncertainAuditError } = await supabase.from('audit_logs').insert({
          restaurant_id: terminal.restaurantId,
          action: 'payment.verification_uncertain',
          entity_type: 'order',
          entity_id: orderId,
          metadata: {
            reason,
            // Both figures, so the disagreement can be settled from the audit row alone.
            // finaticAmount null is the "never checked" case and must stay distinguishable.
            finaticAmount: gatewayAmount,
            expectedAmount,
            amountVerified: false,
            finaticStatus: result.status,
            finaticTransactionId: result.transactionId,
            businessOrderNo: merchantOrderNo,
            terminalId: terminal.terminalId,
            source: 'terminal_verify_payment',
            outcome: 'left_pending_finatic_uncertain',
          },
        })
        if (uncertainAuditError) {
          console.error(
            '[terminal/verify-payment] payment.verification_uncertain audit failed:',
            uncertainAuditError,
          )
        }

        outcome = 'left_pending_finatic_uncertain'
      } else {
        const claim = await markOrderPaidConfirmed(supabase, {
          orderId,
          restaurantId: terminal.restaurantId,
          reference: merchantOrderNo,
          voucherNo: result.transactionId || merchantOrderNo,
          amount: expectedAmount,
          terminalId: terminal.terminalId,
          source: 'terminal_verify_payment',
        })
        applied = claim.claimed
      }
    }

    /**
     * Still HTTP 200, deliberately. The query itself succeeded, and `applied: false` already
     * meant "not applied" to every terminal build in the field — an older APK reading only
     * `paid`/`applied` behaves exactly as it does today. `outcome` is additive: it names WHY
     * nothing was applied, which is the ambiguity #190 is about.
     */
    return NextResponse.json({
      ok: true,
      paid: result.paid,
      applied,
      outcome,
      source: 'finatic',
      merchantOrderNo: result.merchantOrderNo,
      transactionId: result.transactionId,
      status: result.status,
      amount: result.amount,
      expectedAmount,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Verify payment failed'
    console.error('[terminal/verify-payment]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
