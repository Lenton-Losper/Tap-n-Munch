import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  VERIFY_PAYMENT_OUTCOME_CODES,
  VERIFY_PAYMENT_STAFF_MESSAGE,
} from '@/lib/payments/verify-payment-outcome'
import {
  queryFinaticOrderPaid,
  isFinaticMerchantOrderInvalidError,
  finaticErrorCode,
} from '@/lib/payments/query-finatic-order-paid'
import { amountsMatch, GATEWAY_AMOUNT_TOLERANCE_CENTS } from '@/lib/payments/payment-integrity'
import { recordPaymentAmountMismatch } from '@/lib/payments/record-amount-mismatch'
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

    /**
     * #153 — SITE TWO. Until now this call sat bare inside the outer try, so a venue with no
     * Finatic credentials fell into the catch at the bottom and came back as HTTP 502 carrying
     * the raw exception text. 502 is Bad Gateway: it tells staff the payment provider is
     * unreachable and that waiting is the answer. Nothing is unreachable. There is no query to
     * make, because there is nothing to make it with, and no amount of waiting produces one.
     *
     * THE PATTERN ALREADY EXISTED — app/api/orders/route.ts:664 wraps the identical call and
     * returns a distinct 400 naming the real cause, and push-to-terminal/route.ts:163 does the
     * same. This route and the stale-POS cron were the two call sites that did not, and #153 is
     * both of them.
     *
     * 400, matching those two, and NOT 502: this is a configuration fault on our side, not a
     * failure of an upstream service, and the code is what a future terminal build branches on.
     *
     * `paid: false` IS NOT AN ANSWER ABOUT THE MONEY here, and the response says so with
     * `verified: false`. The device-side WiseCashier flow charges under the reader's own merchant,
     * which this system does not record, so a missing credential row proves nothing about whether
     * the card was charged. Presenting this as "not paid" would invite staff to charge twice.
     */
    let merchantNo: string
    let storeNo: string
    try {
      const credentials = await getRestaurantFinaticCredentials(terminal.restaurantId)
      merchantNo = credentials.merchantNo
      storeNo = credentials.storeNo
    } catch (credErr) {
      if (!isMissingFinaticCredentialsError(credErr)) throw credErr
      console.error(
        `[terminal/verify-payment] order ${orderId}: restaurant ${terminal.restaurantId} has no Finatic ` +
          'credentials -- the gateway cannot be queried. Not a connectivity problem.',
      )
      return NextResponse.json(
        {
          ok: false,
          paid: false,
          applied: false,
          // Explicit: the question was never asked, so `paid: false` is the absence of an answer
          // and not a negative one. Distinguishing these is the whole of #153.
          verified: false,
          code: VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED,
          error: VERIFY_PAYMENT_STAFF_MESSAGE[
            VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED
          ],
          merchantOrderNo,
          transactionId: null,
          status: 'credentials_not_configured',
        },
        { status: 400 },
      )
    }

    /**
     * #354 — E04111 IS A FOURTH STATE, AND IT WAS BEING REPORTED AS THE MOST ALARMING ONE.
     *
     * `queryPaymentOrder` throws on any non-success gateway code, so an E04111 ("no record of this
     * merchant order number") fell all the way to the outer catch and came back as HTTP 502
     * `payment_provider_unreachable` — "we could not complete the check". That is wrong in both
     * directions at once: the provider WAS reached, answered immediately and answered clearly, and
     * the staff message told an operator to retry a check whose answer will not change by retrying.
     *
     * It is the same conflation #153 fixed one level up (unreachable vs unconfigured), surviving
     * in a state nobody had separated out. Measured 2026-08-27: every one of the six stranded
     * Mingle orders answers E04111, and the positive control on the same credentials answers
     * `paid=true` in the same run — so the gateway is emphatically reachable.
     *
     * WHAT IT MAPS TO, AND WHY NOT SOMETHING STRONGER. `NOT_CONFIRMED`, HTTP 200, `verified: true`.
     * E04111 means "not registered at the gateway YET" and it is TIME-DEPENDENT: order #149
     * answered E04111 and was confirmed PAID on the same reference 22 seconds later. So it must
     * never be presented as a final "not paid", and the signed NOT_CONFIRMED copy says exactly the
     * right thing — "no confirmation yet. this can still change - check again shortly. do not take
     * a second payment on the strength of this."
     *
     * `isE04111` IS THE POINT OF THIS CHANGE. The terminal cannot distinguish this state from an
     * ordinary not-paid on the wire, and it must never match on provider prose — the same rule
     * that keeps the cancel codes on `result` rather than `resultMsg`. It is a computed boolean the
     * server already puts in its own audit metadata, so this surfaces an existing fact rather than
     * inventing a concept. vc103 ships the terminal's mapping INERT, waiting for this field.
     *
     * Additive for a fielded build: an old APK reads `paid`/`applied` and behaves as it does today.
     * What changes is that it stops being told the provider is unreachable when it isn't.
     */
    let result: Awaited<ReturnType<typeof queryFinaticOrderPaid>>
    try {
      result = await queryFinaticOrderPaid({ merchantOrderNo, merchantNo, storeNo })
    } catch (queryErr) {
      if (!isFinaticMerchantOrderInvalidError(queryErr)) throw queryErr

      const gatewayCode = finaticErrorCode(queryErr) ?? 'E04111'
      console.log('[terminal/verify-payment] E04111 — gateway has no record of this reference', {
        orderId,
        terminalId: terminal.terminalId,
        merchantOrderNo,
        gatewayCode,
      })

      /**
       * The audit row is what makes the PERSISTENCE ruling possible later: two observations at
       * least 24h apart are required before an E04111 may authorise a cancel, and they are read
       * back from exactly these rows, keyed on `businessOrderNo`. Best-effort — a failed audit
       * write must not turn a clean answer into a 502.
       */
      const { error: e04AuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'payment.verification_uncertain',
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          reason: `PayCloud query failed: ${gatewayCode}`,
          outcome: 'left_pending_finatic_uncertain',
          isE04111: true,
          gatewayCode,
          businessOrderNo: merchantOrderNo,
          terminalId: terminal.terminalId,
          credentialsMissing: false,
        },
      })
      if (e04AuditError) {
        console.error('[terminal/verify-payment] E04111 audit failed:', e04AuditError)
      }

      return NextResponse.json({
        ok: true,
        paid: false,
        applied: false,
        outcome: 'left_pending_finatic_uncertain',
        // The gateway answered. That is what separates this from the outer catch's 502.
        verified: true,
        isE04111: true,
        gatewayCode,
        code: VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED,
        staffMessage: VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED],
        source: 'finatic',
        merchantOrderNo,
        transactionId: null,
        status: 'no_gateway_record',
      })
    }

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

        /**
         * TWO ACTIONS, DELIBERATELY, and only one of them fires on both branches (ruled).
         *
         *   payment.amount_mismatch        (#187) -- "we checked, and the figures disagreed"
         *   payment.verification_uncertain (#190) -- "the payment's state is not established"
         *
         * They record different facts, so the mismatch row is kept rather than retired into the
         * canonical one: dropping it would cost the ability to answer "did we check?" at all,
         * and a duplicate row on one branch costs nothing. Reconciliation keys on
         * verification_uncertain either way.
         *
         * NOT written when the amount is ABSENT. A mismatch row carrying receivedAmount: null
         * would assert a comparison that never happened -- null is "never checked", not "checked
         * and disagreed", and keeping those distinguishable is the whole point of the #190 split.
         */
        if (gatewayAmount != null) {
          await recordPaymentAmountMismatch(supabase, {
            restaurantId: terminal.restaurantId,
            orderId,
            expectedAmount,
            receivedAmount: gatewayAmount,
            source: 'terminal_verify_payment',
            terminalId: terminal.terminalId,
            businessOrderNo: merchantOrderNo,
            reference: merchantOrderNo,
          })
        }

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
      /**
       * #153. The gateway WAS asked and answered here -- that is what separates this response
       * from the credentials branch above, where `paid: false` means the question was never put.
       * `code` is only set when there is nothing to confirm; a confirmed payment needs no
       * explanation and setting one would give the terminal something to display on success.
       */
      verified: true,
      code: result.paid ? null : VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED,
      staffMessage: result.paid
        ? null
        : VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED],
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
    /**
     * #153. STILL 502, and now it means what 502 says. The credentials case was pulled out above,
     * so what reaches here is genuinely a failed or unreachable check -- transient, and retrying
     * IS the right advice.
     *
     * `error` keeps the raw message so an operator reading logs loses nothing; `staffMessage` is
     * what a screen should show. They are separate fields because the exception text has never
     * been fit to put in front of a human and this is not the change that makes it so.
     */
    return NextResponse.json(
      {
        ok: false,
        verified: false,
        code: VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE,
        staffMessage:
          VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE],
        error: message,
      },
      { status: 502 },
    )
  }
}
