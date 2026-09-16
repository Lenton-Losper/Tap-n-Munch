import type { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  amountsMatch,
  CLAIMABLE_PAYMENT_STATUSES,
  GATEWAY_AMOUNT_TOLERANCE_CENTS,
} from '@/lib/payments/payment-integrity'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { isMissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'
import {
  finaticErrorCode,
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
  type FinaticOrderPaidResult,
} from '@/lib/payments/query-finatic-order-paid'
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { stagingFinaticQueryStub } from '@/lib/payments/staging-finatic-stub'
/**
 * The audit action the other three cancel paths already write when a Finatic answer is not one we
 * know how to read. Imported from its canonical definition rather than restated, so the three
 * existing consumers and this one can never drift apart.
 */
import { VERIFICATION_SKIPPED_ACTION } from '@/lib/orders/auto-cancel-stale-pos-orders'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type HandleTerminalPaymentFailedParams = {
  orderId: string
  restaurantId: string
  /** Order total (major units) — used when Finatic omits amount. */
  orderTotal: number
  /** From prepare-payment; empty/null means no Finatic attempt was initiated. */
  paycloudMerchantOrderNo: string | null | undefined
  terminalId?: string | null
  /** Terminal-supplied failure reference (e.g. FT-FAIL-…). */
  reference?: string
  amount?: number
  paymentMethod?: string
  /**
   * Reason written on cancel. Defaults to payment_declined (payment callback).
   * Status-route cancels pass terminal_cancelled (or a caller-supplied reason).
   */
  cancellationReason?: string
  /** audit_logs.action on cancel. Defaults to payment.failed. */
  auditAction?: string
  /** markOrderPaidConfirmed source when Finatic confirms paid. */
  correctionSource?: string
  /** Extra text for the correction audit metadata. */
  correctionReason?: string
  /**
   * Set ONLY by the terminal when it has positively identified an operator abort that happened
   * before the reader contacted the gateway. See TERMINAL_USER_CANCELLED_REASON.
   */
  noGatewayAttempt?: boolean
  /**
   * The raw WiseCashier `result` code the device reported, e.g. "N002" (D-4).
   *
   * DIAGNOSTIC ONLY. It is written into the audit metadata of whichever outcome this call reaches
   * and is read by nothing: there is no branch anywhere in this function on its value, and adding
   * one would turn a device-asserted string into a control over whether money is verified. Absent
   * on every terminal build before this change, which is why it is optional and why null means
   * "not reported" rather than "none".
   */
  gatewayResult?: string | null
}

/**
 * The one cancellation reason that may bypass Finatic verification.
 *
 * Why the bypass is safe for this value and nothing else: a payment order is created at the
 * gateway only when the reader actually contacts it. An operator abort happens before that, so
 * there is no payment order to find and no charge to miss. Verification cannot tell us anything
 * — it returns E04111 ("no such merchant order"), which is exactly what has been leaving these
 * orders pending forever.
 *
 * HOW THE TERMINAL IDENTIFIES THAT ABORT (corrected 2026-08-10, terminal vc83): NOT by
 * Activity.RESULT_CANCELED. WiseCashier never returns it — `AppInvokeUtilKt.onAppInvokeFail` is
 * hardcoded `setResult(-1, ...)`, so every failure arrives as RESULT_OK and is distinguished
 * only by the `result` extra. An operator abort is gateway code **K026**, confirmed on a UAT P5
 * and against WiseCashier's own bytecode. Sibling codes on the identical path — K027 timeout,
 * K017 processing, K036/K037 auto-reversal — must NEVER reach this bypass. See
 * docs/wisecashier-result-codes.md in the terminal repo.
 *
 * The match is EXACT (===). Not startsWith, not includes, not a regex. A reason that merely
 * looks similar must go through the gate like everything else, because the cost of bypassing
 * wrongly is cancelling an order the customer was actually charged for.
 */
export const TERMINAL_USER_CANCELLED_REASON = 'terminal_cancelled_by_user_pre_gateway'

/**
 * What a cancellation's audit row may claim about HOW the money state was established.
 *
 * Exported so tests assert against the vocabulary rather than restating string literals, and so a
 * future consumer that groups on `evidence_basis` has the complete set in one place. Additive:
 * `no_attempt_recorded` (D-2) joins the two values that already existed, and no non-test consumer
 * reads the field today.
 */
export const CANCEL_EVIDENCE_BASES = [
  /** The terminal asserted an operator abort (K026) before the gateway was contacted. */
  'terminal_asserted',
  /** Finatic was queried for this reference and answered, recognisably, not-paid. */
  'gateway_verified',
  /** No merchant order number exists, so no gateway attempt was ever recorded to ask about. */
  'no_attempt_recorded',
] as const

export type CancelEvidenceBasis = (typeof CANCEL_EVIDENCE_BASES)[number]

export type HandleTerminalPaymentFailedResult =
  | {
      outcome: 'cancelled'
      cancellationReason: string
      cancelledAt: string
    }
  | {
      outcome: 'corrected_to_paid'
      claimed: boolean
      tabId: string | null
    }
  | {
      outcome: 'left_pending_finatic_uncertain'
      reason: string
    }
  | {
      outcome: 'cancel_conflict'
    }

export type HandleTerminalPaymentFailedOptions = {
  /** Test-only seam: override the Finatic query call. Defaults to the real implementation. */
  queryFinaticOrderPaidFn?: typeof queryFinaticOrderPaid
  /**
   * Staging-only: request body `__stagingFinaticStub` ('paid' | 'not_paid' | 'unreachable').
   * Ignored unless ENVIRONMENT=staging (wrangler staging vars).
   */
  stagingFinaticStub?: unknown
}

/**
 * Shared Finatic-before-cancel for terminal payment-failed and status=cancelled
 * when a charge may already have been initiated (paycloud_merchant_order_no set).
 *
 *  - No paycloud_merchant_order_no → cancel immediately (nothing to verify), recorded with
 *    evidence_basis 'no_attempt_recorded' and charge_status_known FALSE — the gateway was never
 *    asked, and the row must not claim otherwise (D-2).
 *  - Finatic confirms paid → correct to paid via markOrderPaidConfirmed (false-failure).
 *  - Finatic confirms not paid AND the status is one we recognise → cancel with the
 *    caller-supplied reason.
 *  - Finatic answers with a status we do NOT recognise → leave payment_status pending and write a
 *    payment.verification_skipped audit. An unrecognised answer is not a "not paid" answer, and
 *    unknown never authorises a cancel (D-1).
 *  - Finatic unreachable/errors/missing credentials → leave payment_status pending
 *    and write payment.verification_uncertain audit (cron may still resolve later).
 */
export async function handleTerminalPaymentFailed(
  supabase: Supabase,
  params: HandleTerminalPaymentFailedParams,
  options?: HandleTerminalPaymentFailedOptions,
): Promise<HandleTerminalPaymentFailedResult> {
  const cancellationReason = (params.cancellationReason || 'payment_declined').trim() || 'payment_declined'
  const auditAction = params.auditAction || 'payment.failed'
  const correctionSource =
    params.correctionSource || 'terminal_callback_false_failure_finatic_verified'
  const correctionReason =
    params.correctionReason ||
    'Terminal reported failure/cancel, but Finatic order.query confirmed a successful charge — corrected to paid instead of cancelling (false-failure guard).'

  const stubFn = stagingFinaticQueryStub(options?.stagingFinaticStub)
  const queryFn = options?.queryFinaticOrderPaidFn ?? stubFn ?? queryFinaticOrderPaid
  const merchantOrderNo = String(params.paycloudMerchantOrderNo || '').trim()
  const paymentMethod = params.paymentMethod || 'card'
  const terminalId = params.terminalId ?? null

  /**
   * The bypass. BOTH conditions are required, and the reason must match EXACTLY.
   *
   * `noGatewayAttempt` alone is not enough: a caller could set it by mistake on an ordinary
   * decline. The exact-reason check means a wrong flag cannot silently skip verification unless
   * the caller ALSO names this specific reason, which nothing else in the codebase does.
   */
  const skipVerification =
    params.noGatewayAttempt === true && cancellationReason === TERMINAL_USER_CANCELLED_REASON

  if (skipVerification) {
    console.log(
      `[handleTerminalPaymentFailed] order ${params.orderId}: user cancelled on the reader before ` +
        'the gateway was contacted — cancelling without Finatic verification (no payment order can exist).',
    )
  }

  if (merchantOrderNo && !skipVerification) {
    try {
      const usingInjectedQuery = Boolean(options?.queryFinaticOrderPaidFn || stubFn)
      let merchantNo = 'STAGING_STUB'
      let storeNo = 'STAGING_STUB'
      if (!usingInjectedQuery) {
        const creds = await getRestaurantFinaticCredentials(params.restaurantId)
        merchantNo = creds.merchantNo
        storeNo = creds.storeNo
      } else {
        // Best-effort real creds for stubs/seams; placeholders if the probe restaurant
        // has none (common on throwaway staging fixtures).
        try {
          const creds = await getRestaurantFinaticCredentials(params.restaurantId)
          merchantNo = creds.merchantNo
          storeNo = creds.storeNo
        } catch {
          // keep placeholders
        }
      }

      const finatic: FinaticOrderPaidResult = await queryFn({
        merchantOrderNo,
        merchantNo,
        storeNo,
      })

      if (finatic.paid) {
        /**
         * The gateway's figure has to agree with the order before it is written as the amount
         * collected. verify-payment/route.ts has always checked this; this path reached
         * markOrderPaidConfirmed with `finatic.amount ?? orderTotal` unchecked, so two routes
         * asking Finatic the same question disagreed about whether the answer needed verifying.
         *
         * A disagreement is NOT cancelled. Finatic has just said the customer was charged, and
         * cancelling on a quibble about the figure is the exact failure this whole path exists
         * to prevent. Neither is it corrected using the order total instead: if the reference
         * has correlated to a different sale, that marks THIS order paid on somebody else's
         * money, and the row would look entirely ordinary afterwards.
         *
         * So it takes the outcome that already models "this order's money state is not
         * established" — left pending, nothing written, visible in the audit trail, and
         * resolvable by the reconcile cron or a human. Both callers already handle it.
         *
         * EXACT agreement, not the one-cent client tolerance (#190). Finatic echoes back our own
         * figure, so nothing in the round trip can produce a legitimate cent — see
         * GATEWAY_AMOUNT_TOLERANCE_CENTS.
         *
         * A MISSING AMOUNT IS UNVERIFIED, AND IS REFUSED TOO. This reverses what this comment
         * said until #190 ("a missing amount is not a disagreeing amount"), which let an absent
         * field fall through to the order total. If the gateway did not give us an amount, we
         * did not verify the amount, and applying the payment while recording "never checked" is
         * the same shape as the unguarded write #180 closed. The safe default holds whether or
         * not the null branch is live. queryFinaticOrderPaid normalises through toMoney, so null
         * means the field was genuinely absent or unparseable, not merely oddly formatted.
         */
        const gatewayAmount = finatic.amount
        const amountVerified =
          gatewayAmount != null &&
          amountsMatch(gatewayAmount, params.orderTotal, GATEWAY_AMOUNT_TOLERANCE_CENTS)

        if (!amountVerified) {
          const reason =
            gatewayAmount == null
              ? `Finatic reports paid but returned no amount for ${merchantOrderNo} — the amount was ` +
                'never verified, so the order is not corrected to paid, and not cancelled either.'
              : `Finatic reports paid but for ${gatewayAmount}, not the order total ${params.orderTotal} — ` +
                'not correcting to paid, and not cancelling an order the gateway says was charged.'
          console.error(`[handleTerminalPaymentFailed] order ${params.orderId}: ${reason}`)

          const { error: mismatchAuditError } = await supabase.from('audit_logs').insert({
            restaurant_id: params.restaurantId,
            action: 'payment.verification_uncertain',
            entity_type: 'order',
            entity_id: params.orderId,
            metadata: {
              reason,
              // Both figures, so the disagreement can be settled from the audit row alone.
              // A null finaticAmount is the "never checked" case and must stay distinguishable
              // from a figure that was checked and agreed.
              finaticAmount: gatewayAmount,
              expectedAmount: params.orderTotal,
              amountVerified: false,
              terminalReportedAmount: params.amount ?? null,
              finaticStatus: finatic.status,
              finaticTransactionId: finatic.transactionId,
              businessOrderNo: merchantOrderNo,
              reference: params.reference || null,
              gatewayResult: params.gatewayResult ?? null,
              terminalId,
              requestedCancellationReason: cancellationReason,
              outcome: 'left_pending_finatic_uncertain',
            },
          })
          if (mismatchAuditError) {
            console.error(
              '[handleTerminalPaymentFailed] amount-mismatch audit failed:',
              mismatchAuditError,
            )
          }

          return { outcome: 'left_pending_finatic_uncertain', reason }
        }

        const claim = await markOrderPaidConfirmed(supabase, {
          orderId: params.orderId,
          restaurantId: params.restaurantId,
          reference: merchantOrderNo,
          voucherNo: finatic.transactionId || merchantOrderNo,
          // Non-null and exactly equal to orderTotal by the guard above — the previous
          // `?? params.orderTotal` fallback was the null-skips-verification path (#190).
          amount: gatewayAmount,
          // #268: this caller's `amount` IS the gateway's figure; saying so explicitly stops the
          // audit entry claiming it is the order total.
          gatewayAmount,
          paymentMethod,
          terminalId,
          source: correctionSource,
          extraAuditMetadata: {
            correctionReason,
            terminalReportedReference: params.reference || null,
            terminalReportedAmount: params.amount ?? null,
            requestedCancellationReason: cancellationReason,
            finaticStatus: finatic.status,
            finaticTransactionId: finatic.transactionId,
            finaticAmount: finatic.amount,
          },
          fromPaymentStatuses: [...CLAIMABLE_PAYMENT_STATUSES],
        })

        return {
          outcome: 'corrected_to_paid',
          claimed: claim.claimed,
          tabId: claim.claimed ? claim.tabId : null,
        }
      }

      /**
       * ==========================================================================================
       * AN UNRECOGNISED STATUS NEVER AUTHORISES A CANCEL (D-1)
       * ==========================================================================================
       *
       * `paid` is a boolean, so EVERY value the gateway could return that is not a recognised
       * success collapses into "not paid" — including a status nobody has ever seen. Without this
       * branch the line below cancelled the order, and cancelling means writing
       * payment_status='cancelled' on a card that may well have cleared.
       *
       * THIS IS NOT A NEW RULING. It was made on 2026-08-22 and is already implemented by the
       * three other paths that cancel on a Finatic answer:
       *
       *   lib/orders/auto-cancel-stale-pos-orders.ts   `else if (!finaticResult.statusRecognised)`
       *   lib/orders/override-cancel.ts                `refuse('gateway_status_unrecognised')`
       *   lib/orders/clear-held-for-review.ts          `if (!answer.statusRecognised)`
       *
       * `queryFinaticOrderPaid` states the contract in the opposite direction and names this
       * caller's obligation explicitly: "A caller that CANCELS on not-paid must check this first."
       * This handler — the one every terminal payment failure goes through — was the one that did
       * not. The fix applies the existing ruling here; it invents nothing.
       *
       * NOBODY HAS THE ENUM. Measured 2026-08-21 across 43 live order.query calls spanning three
       * restaurants and four weeks, exactly two `trans_status` values have ever been observed: 2
       * (paid) and 1 (failed). No vendor documentation of the field exists. A 3 would have
       * cancelled a real customer's order.
       *
       * IT TAKES AN OUTCOME THAT ALREADY EXISTS. `left_pending_finatic_uncertain` already means
       * "this order's money state is not established" — nothing written, visible in the audit
       * trail, resolvable by a human. Both production callers already handle it, so no caller
       * changes and no response shape changes.
       *
       * SAME ASYMMETRY AS THE E04111 RULING (2026-08-05): an E04111 THROWS and is skipped safely
       * by the catch below; an unrecognised status returned *successfully* did not skip, and that
       * is the gap this closes. Both now leave the order pending.
       *
       * RECORDED, NOT MERELY SKIPPED. If Finatic ever returns a third value the owner must find
       * out from the database rather than from a cancelled customer order, so the audit row names
       * the value verbatim.
       */
      if (!finatic.statusRecognised) {
        const reason =
          `Finatic returned a status this system does not recognise (${finatic.status}) for ` +
          `${merchantOrderNo}. An unrecognised answer is not a "not paid" answer, so the order is ` +
          'not cancelled and not corrected to paid.'
        console.error(`[handleTerminalPaymentFailed] order ${params.orderId}: ${reason}`)

        const { error: unknownAuditError } = await supabase.from('audit_logs').insert({
          restaurant_id: params.restaurantId,
          action: VERIFICATION_SKIPPED_ACTION,
          entity_type: 'order',
          entity_id: params.orderId,
          metadata: {
            reason,
            source: 'terminal_payment_failed',
            // Verbatim, so the unknown value is recoverable from the row alone.
            finaticStatus: finatic.status,
            statusRecognised: false,
            finaticPaid: finatic.paid,
            finaticAmount: finatic.amount,
            finaticTransactionId: finatic.transactionId,
            expectedAmount: params.orderTotal,
            terminalReportedAmount: params.amount ?? null,
            businessOrderNo: merchantOrderNo,
            reference: params.reference || null,
            gatewayResult: params.gatewayResult ?? null,
            terminalId,
            requestedCancellationReason: cancellationReason,
            outcome: 'left_pending_finatic_uncertain',
          },
        })
        if (unknownAuditError) {
          console.error(
            '[handleTerminalPaymentFailed] unrecognised-status audit failed:',
            unknownAuditError,
          )
        }

        return { outcome: 'left_pending_finatic_uncertain', reason }
      }

      // Finatic recognisably not paid — fall through to cancel.
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[handleTerminalPaymentFailed] Finatic check failed for order ${params.orderId} — leaving pending:`,
        reason,
      )

      // Visibility only — order stays pending (same as before). Without this audit the
      // uncertain path looks identical to "terminal never reported failure."
      const { error: uncertainAuditError } = await supabase.from('audit_logs').insert({
        restaurant_id: params.restaurantId,
        action: 'payment.verification_uncertain',
        entity_type: 'order',
        entity_id: params.orderId,
        metadata: {
          reason,
          gatewayCode: finaticErrorCode(err),
          // E04111 = "Finatic has no record of this reference yet", which is a very
          // different situation from an unreachable gateway even though both land here.
          isE04111: isFinaticMerchantOrderInvalidError(err),
          /**
           * #153 — RECORDED, NOT ACTED ON. This path's behaviour is unchanged and deliberately
           * so: leaving the order pending is already the safe outcome here, and the
           * left_pending_finatic_uncertain guard is a ruled decision that this issue does not
           * reopen.
           *
           * What was missing is that the DATABASE could not tell the third condition apart from
           * the other two. Digi Cofee order #28 carries five of these rows from 2026-08-26, all
           * of them credentials-missing, and the only way to know that today is to string-match
           * `metadata.reason` — which is how this was in fact established. One boolean makes the
           * class countable.
           */
          credentialsMissing: isMissingFinaticCredentialsError(err),
          businessOrderNo: merchantOrderNo,
          reference: params.reference || null,
          amount: params.amount ?? null,
          gatewayResult: params.gatewayResult ?? null,
          terminalId,
          requestedCancellationReason: cancellationReason,
          outcome: 'left_pending_finatic_uncertain',
        },
      })
      if (uncertainAuditError) {
        console.error(
          '[handleTerminalPaymentFailed] payment.verification_uncertain audit failed:',
          uncertainAuditError,
        )
      }

      return { outcome: 'left_pending_finatic_uncertain', reason }
    }
  }

  const cancelledAt = new Date().toISOString()
  const { data: cancelled, error: cancelError } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancellation_reason: cancellationReason,
      cancelled_at: cancelledAt,
    })
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .in('payment_status', [...CLAIMABLE_PAYMENT_STATUSES])
    .select('id, status, payment_status, cancellation_reason, cancelled_at')
    .maybeSingle()

  if (cancelError) throw cancelError

  if (!cancelled) {
    return { outcome: 'cancel_conflict' }
  }

  /**
   * Decided once, read three times below, so the basis, the known-flag and the prose sentence can
   * never disagree with each other — which is how the wrong pair got written in the first place.
   */
  const cancelEvidenceBasis: CancelEvidenceBasis = skipVerification
    ? 'terminal_asserted'
    : merchantOrderNo
      ? 'gateway_verified'
      : 'no_attempt_recorded'

  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: params.restaurantId,
    action: auditAction,
    entity_type: 'order',
    entity_id: params.orderId,
    metadata: {
      reference: params.reference || null,
      amount: params.amount ?? null,
      gatewayResult: params.gatewayResult ?? null,
      terminalId,
      cancellation_reason: cancellationReason,
      // Was a merchant_order_no present AND actually verified? The bypass makes those two
      // different questions, so this must no longer be inferred from the reference alone.
      finaticVerifiedBeforeCancel: Boolean(merchantOrderNo) && !skipVerification,
      businessOrderNo: merchantOrderNo || null,
      /**
       * WHICH KIND OF EVIDENCE this cancellation rests on. A reader that says "the operator
       * cancelled" is not the same claim as a gateway that says "no payment exists", and the
       * record must not blur them.
       *
       * THERE ARE THREE KINDS, NOT TWO (D-2). This was a binary ternary on `skipVerification`, so
       * the third case — no merchant order number was ever minted, therefore Finatic was never
       * asked — fell to the `else` and was recorded as `gateway_verified`, `charge_status_known:
       * true`, and a verification_method sentence describing a query that never ran. Three fields
       * describing a gateway confirmation that did not happen.
       *
       * It is reached from the payment route only: the status route guards with
       * `if (merchantOrderNo)` before calling this at all. 18 of 24 cancelled orders sampled on
       * staging carry no reference, so it is the common case, not an edge one.
       *
       * THE CANCEL ITSELF IS UNCHANGED AND IS STILL CORRECT — no reference generally does mean no
       * charge. What changes is only what the row claims about how we know.
       */
      evidence_basis: cancelEvidenceBasis,
      /**
       * FALSE for the no-reference case. Nothing was asked and nothing answered, so the charge
       * status is precisely what is NOT known. No non-test consumer reads this field today
       * (verified by grep across .ts/.tsx/.sql/.mjs before changing it), so narrowing it from a
       * hardcoded `true` cannot break a caller.
       */
      charge_status_known: cancelEvidenceBasis !== 'no_attempt_recorded',
      verification_method:
        cancelEvidenceBasis === 'terminal_asserted'
          ? 'NONE — terminal reported an operator abort (WiseCashier gateway code K026) before the ' +
            'reader contacted the gateway. No payment order can exist, so Finatic was deliberately ' +
            'not queried. This is the terminal\'s assertion, not gateway confirmation.'
          : cancelEvidenceBasis === 'no_attempt_recorded'
            ? 'NONE — this order carries no merchant order number, so no gateway attempt was ever ' +
              'recorded and Finatic could not be queried. The cancellation rests on the absence of ' +
              'a reference, not on a gateway answer.'
            : 'Finatic order.query returned not-paid for this reference before cancelling',
    },
  })
  if (auditError) {
    console.error('[handleTerminalPaymentFailed] audit log failed:', auditError)
  }

  return {
    outcome: 'cancelled',
    cancellationReason,
    cancelledAt,
  }
}
