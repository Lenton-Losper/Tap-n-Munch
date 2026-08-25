import {NativeModules, Platform} from 'react-native';
import {APP_VERSION, PAYMENT_RESULT_TIMEOUT_MS} from '../constants';
import {
  markTerminalPaymentAttemptStarted,
  prepareTerminalPayment,
  verifyTerminalPayment,
} from './api';
import {PAYMENT_TIMED_OUT_MESSAGE} from '../constants/paymentCopy';
import {getTerminalToken, holdOrphanPayment} from './storage';
import {decideOrphanDisposition} from './orphanPaymentGuard';
import {recordWiretapEvent} from './wiretap';

export type PaymentOutcomeKind =
  | 'success'
  | 'confirmed_failure'
  | 'ambiguous'
  | 'orphaned_success'
  | 'orphaned_ambiguous'
  /**
   * The operator dismissed WiseCashier before the reader contacted the gateway. Distinct from
   * 'ambiguous': no payment order can exist, so the server may cancel without a Finatic verify.
   * Raised ONLY from Activity.RESULT_CANCELED in native -- never inferred from message text.
   */
  | 'user_cancelled';

export interface PaymentResult {
  success: boolean;
  /** Preferred gateway ref for completePayment / settleTab (voucherNo first). */
  reference?: string;
  voucherNo?: string;
  businessOrderNo?: string;
  error?: string;
  /**
   * How sure we are about the device-level outcome.
   * - success / orphaned_success: device returned voucher
   * - ambiguous / orphaned_ambiguous: do NOT treat like a confirmed decline —
   *   caller should verify with Finatic before reporting failure
   * - confirmed_failure: device/gateway confirmed no charge (e.g. a known decline code) —
   *   safe to report as failed without a Finatic verify round-trip
   */
  outcomeKind?: PaymentOutcomeKind;
  orphaned?: boolean;
  /** Raw gateway result code (e.g. "N003") when the native side reported one. */
  gatewayResult?: string;
  /**
   * #344 ruling 4. Set when this result came from a NON-DESTRUCTIVE peek, meaning the native
   * record still exists and must be cleared once the payload is durably held. Absent when it
   * came from the legacy destructive consume, where there is nothing left to clear.
   */
  receiptToken?: string;
  /**
   * #344. The order this payment was launched FOR, as the native side recorded it at launch
   * (KEY_PENDING_ORDER). Carried so a recovered orphan can be compared against the order on
   * screen instead of being applied to whatever happens to be there. May be a comma-separated
   * list for a tab settle, and is "" when native had no pending record.
   */
  orderId?: string;
}

interface PaymentNativeResult {
  voucherNo?: string;
  businessOrderNo?: string;
  outcome?: string;
  orphaned?: boolean;
  error?: string;
  orderId?: string;
  merchantOrderNo?: string;
  gatewayResult?: string;
  /** #344 ruling 4. Present only on a peeked payload; identifies which orphan to clear. */
  receiptToken?: string;
}

export interface RefundResult {
  status: 'APPROVED' | 'WRONG_CARD' | 'DECLINED' | 'CANCELLED' | 'FAILED';
  retryable: boolean;
  transactionId?: string;
  businessOrderNo?: string;
  gateway: {code: string; message: string};
}

interface RefundNativeResult {
  status: RefundResult['status'];
  retryable: boolean;
  transactionId?: string;
  businessOrderNo?: string;
  gateway: {code: string; message: string};
}

interface PaymentModuleType {
  launchPayment: (
    amount: string,
    orderId: string,
    merchantOrderNo: string,
  ) => Promise<PaymentNativeResult>;
  launchRefund: (
    amount: string,
    originBusinessOrderNo: string,
  ) => Promise<RefundNativeResult>;
  consumeOrphanedPaymentResult?: () => Promise<PaymentNativeResult | null>;
  /**
   * #344 ruling 4. Non-destructive read; the payload carries a receiptToken for the paired
   * clear. OPTIONAL because an APK older than vc96 does not have it — see consumeOrphanedIfAny,
   * which falls back to the destructive consume rather than losing the orphan entirely.
   */
  peekOrphanedPaymentResult?: () => Promise<PaymentNativeResult | null>;
  /** #344 ruling 4. Clears only while the stored payload still matches the token. */
  clearOrphanedPaymentResult?: (receiptToken: string) => Promise<boolean>;
  /** INSTRUMENTATION (vc82) — see WiretapEntry. Optional: older installs will not have it. */
  readWiseCashierWiretap?: () => Promise<string>;
  clearWiseCashierWiretap?: () => Promise<boolean>;
}

const {PaymentModule} = NativeModules as {PaymentModule?: PaymentModuleType};

/**
 * One raw WiseCashier interaction, recorded natively before FlashTap classifies anything.
 * Written by PaymentModule.recordWiretap / recordActivityReturn; rendered on Diagnostics.
 * Every field is optional because the point of the log is to show what actually arrived,
 * including shapes we did not anticipate.
 */
export interface WiretapEntry {
  event?: string;
  at?: number;
  requestCode?: number;
  requestCodeName?: string;
  resultCode?: number;
  resultCodeName?: string;
  dataNull?: boolean;
  action?: string;
  dataString?: string;
  component?: string;
  flags?: number;
  type?: string;
  categories?: string;
  extrasNull?: boolean;
  extrasCount?: number;
  extras?: Array<{key: string; type: string; value: string}>;
  pendingOrderId?: string;
  pendingMerchantOrderNo?: string;
  promiseAlive?: boolean;
  orderId?: string;
  merchantOrderNo?: string;
  amountMinor?: string;
  paddedAmount?: string;
  code?: string;
  error?: string;
}

/** Newest first. Returns [] when the native method is absent or the log is empty. */
export async function readWiseCashierWiretap(): Promise<WiretapEntry[]> {
  if (!PaymentModule?.readWiseCashierWiretap) {
    return [];
  }
  const raw = await PaymentModule.readWiseCashierWiretap();
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) {
    return [];
  }
  return (parsed as WiretapEntry[]).slice().reverse();
}

export async function clearWiseCashierWiretap(): Promise<void> {
  await PaymentModule?.clearWiseCashierWiretap?.();
}

/** Prefix for backend audit refs when the device did not confirm a Finatic id. */
export const UNCONFIRMED_PAYMENT_REF_PREFIX = 'UNCONFIRMED-';

/** Prefix for backend audit refs on a confirmed gateway decline (carries the gateway code). */
export const DECLINED_PAYMENT_REF_PREFIX = 'DECLINED-';

/**
 * MUST match TERMINAL_USER_CANCELLED_REASON in the server's
 * lib/payments/handle-terminal-payment-failed.ts, character for character.
 *
 * The server compares with === after trimming, and has tests pinning eight adjacent values
 * (case, suffix, truncation) as NON-bypassing. Reword this and the fix silently stops working:
 * orders go back to being verified against a gateway that has no record of them, and strand.
 */
export const TERMINAL_USER_CANCELLED_REASON = 'terminal_cancelled_by_user_pre_gateway';

/**
 * Pulls the raw gateway code back out of a native payment-failure message, e.g.
 * "Battery too low to trade. Please charge your device first. (gateway result=K029)" ->
 * "K029". Native (MainActivity.kt) always appends this exact trailing
 * "(gateway result=XYZ)" substring verbatim, regardless of which display text precedes it
 * (#182 maps several codes to WiseCashier's own English text instead of a generic
 * "not a confirmed success" string) -- that suffix MUST stay intact or this silently stops
 * extracting the code, which is used in the audit reference (declinedFailureReference).
 * Exported so a test can pin the contract independently of any specific message wording.
 */
export function extractGatewayResult(message: string): string | undefined {
  return message.match(/gateway result=(\S+)\)/i)?.[1];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Tab settle historically passed comma-joined order ids into launchPayment. Prepare-payment
 * requires a single order UUID — use the lead id so paycloud_merchant_order_no is persisted
 * on one row the Finatic webhook can find. settleTab still marks the full set paid via the
 * terminal callback.
 */
function resolvePrepareOrderId(orderIdOrList: string): string {
  const trimmed = orderIdOrList.trim();
  if (isUuid(trimmed)) {
    return trimmed;
  }
  const first = trimmed.split(',')[0]?.trim() ?? '';
  if (isUuid(first)) {
    return first;
  }
  throw new Error('orderId must be a UUID (or comma-separated UUIDs for tab settle)');
}

/** Max wait for attempt-started so we don't stall the payment UI if the Worker is slow. */
const ATTEMPT_STARTED_TIMEOUT_MS = 2000;

/**
 * Records WiseCashier launch on the backend. Never throws — payment must continue
 * even if this fails or times out.
 */
async function notifyPaymentAttemptStarted(
  orderId: string,
  token: string,
  businessOrderNo: string,
): Promise<void> {
  try {
    const result = await Promise.race([
      markTerminalPaymentAttemptStarted(orderId, token, {
        businessOrderNo,
        appVersion: APP_VERSION,
        launchedAt: new Date().toISOString(),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `attempt-started timed out after ${ATTEMPT_STARTED_TIMEOUT_MS}ms`,
              ),
            ),
          ATTEMPT_STARTED_TIMEOUT_MS,
        );
      }),
    ]);
    console.log('[payment] attempt-started', {
      orderId,
      businessOrderNo,
      recorded: result.recorded,
      startedAt: result.startedAt,
    });
  } catch (err) {
    console.warn(
      '[payment] attempt-started failed (payment continues)',
      err instanceof Error ? err.message : err,
    );
  }
}

function mapNativeSuccess(result: PaymentNativeResult): PaymentResult {
  const voucherNo = String(result.voucherNo ?? '').trim() || undefined;
  const businessOrderNo =
    String(result.businessOrderNo ?? '').trim() ||
    String(result.merchantOrderNo ?? '').trim() ||
    undefined;

  // #344. Carried on BOTH exits: the orphan guard needs it whether or not a voucher came back.
  const orderId = String(result.orderId ?? '').trim() || undefined;
  // #344 ruling 4. Rides through so releasePeekedOrphan can clear exactly this record.
  const receiptToken = String(result.receiptToken ?? '').trim() || undefined;

  if (!voucherNo) {
    return {
      success: false,
      businessOrderNo,
      orderId,
      receiptToken,
      orphaned: Boolean(result.orphaned),
      outcomeKind: result.orphaned ? 'orphaned_ambiguous' : 'ambiguous',
      error:
        result.error ||
        'No transaction ID returned from payment app — outcome unconfirmed by device',
    };
  }

  return {
    success: true,
    voucherNo,
    businessOrderNo,
    orderId,
    receiptToken,
    reference: voucherNo,
    orphaned: Boolean(result.orphaned),
    outcomeKind: result.orphaned ? 'orphaned_success' : 'success',
  };
}

/**
 * #183: native (MainActivity.kt onActivityResult, promise == null branch) already computes
 * and persists outcome: 'user_cancelled' for an orphaned callback -- guarded by its own
 * comment: "Same split as the promise path above: an orphaned USER CANCEL must not be
 * reported as ambiguous, or it strands exactly as before." That value survives the round
 * trip through SharedPreferences intact. This function used to only test
 * orphaned.outcome === 'success', so every non-success orphan -- including a correctly
 * tagged cancel -- fell through to 'orphaned_ambiguous' and triggered a doomed Finatic
 * verify (E04111), stranding the order exactly as the native comment says it must not.
 *
 * Trusting outcome === 'user_cancelled' here is not a new judgment call: native sets it
 * ONLY from Activity.RESULT_CANCELED or a USER_CANCEL_RESULT_CODES (K026) match against the
 * resultExtra WiseCashier itself returned -- the same two conditions that drive the live
 * (non-orphaned) path's code === 'PAYMENT_CANCELLED_BY_USER' branch below. "Orphaned" means
 * the JS promise reference was lost (RN bridge/process-death), not that the Android
 * activity-result values themselves are less trustworthy -- the classification happens
 * synchronously in native right when WiseCashier returns, before any orphaning occurs. So
 * the same "a cancel cannot have charged" argument that justifies the live path's
 * no-gateway-attempt bypass applies unchanged here.
 */
/**
 * #344 ruling 4 — clear the native record for an orphan we have finished with.
 *
 * No-op when `receiptToken` is absent, which means the payload came from the legacy destructive
 * consume and there is nothing left to clear. Never throws: failing to clear costs a duplicate
 * read next time, and verify-payment plus the order-match guard both make a duplicate harmless,
 * whereas throwing here would fail the payment in progress.
 */
async function releasePeekedOrphan(orphan: PaymentResult): Promise<void> {
  if (!orphan.receiptToken || !PaymentModule?.clearOrphanedPaymentResult) {
    return;
  }
  try {
    const cleared = await PaymentModule.clearOrphanedPaymentResult(
      orphan.receiptToken,
    );
    if (!cleared) {
      // Native refused because a NEWER orphan replaced this one after the peek. Correct, and
      // worth a line: the newer one is still there to be picked up on the next pass.
      console.warn(
        '[payment] orphan clear declined — a newer orphaned result arrived after the peek',
      );
    }
  } catch (err) {
    console.warn('[payment] failed to clear peeked orphan', err);
  }
}

/**
 * #344 — apply a recovered orphan, or hold it. The single decision point for BOTH call sites.
 *
 * Returns the orphan when it may be applied to `currentOrderId`, and null when it may not — in
 * which case it has already been PERSISTED for someone to check. Callers treat null as "there was
 * nothing here for me" and carry on with the payment in front of them, which is correct: the order
 * on screen still has not been paid.
 *
 * ONE DECISION POINT ABOUT WHICH ORDER, TWO CALL SITES. The order-matching rule lives here so
 * there is only one copy of it.
 *
 * `applyNonSuccess` IS NOT DRIFT BETWEEN THE SITES — IT IS THE DIFFERENCE BETWEEN THEM, and #183
 * depends on it. Read this before "tidying" the two sites into one behaviour:
 *
 *   SITE 1, before the reader is launched (applyNonSuccess: false). A stale SUCCESS for this order
 *     means the order was already paid, so it is applied. A stale CANCEL means the operator is
 *     retrying, and the right answer is to fall through and launch the reader — returning "someone
 *     cancelled earlier" as the outcome of a payment they just started would be wrong.
 *
 *   SITE 2, inside the catch after a launch (applyNonSuccess: true). An orphan naming THIS order
 *     IS this attempt's result, whatever it says. Refusing to apply a matching `user_cancelled`
 *     here is exactly the #183 defect: the cancel falls through to `orphaned_ambiguous`, the server
 *     verifies against a gateway with no record, gets E04111, and the order strands. Native's own
 *     comment says an orphaned USER CANCEL must not be reported as ambiguous.
 *
 * #344 RULING 5 — A NON-SUCCESS ORPHAN IS HELD, NEVER DROPPED. Where site 1 declines to apply one,
 * it used to be consumed and discarded. "A failed orphan still tells us a payment attempt reached
 * a reader and how it ended", so it is held with its outcome instead.
 *
 * HOLDING IS BEST EFFORT AND CANNOT THROW. If persistence fails the orphan is still not applied to
 * the wrong order, so the safety property survives even when the record does not. Throwing here
 * would lose the CURRENT sale as well, turning a bookkeeping failure into a payment failure.
 */
async function applyOrHoldOrphan(
  orphan: PaymentResult,
  currentOrderId: string,
  opts: {applyNonSuccess: boolean},
): Promise<PaymentResult | null> {
  const decision = decideOrphanDisposition(orphan.orderId, currentOrderId);

  // It names this order, but this site may not apply a non-success one. Held rather than dropped.
  const withheldForOutcome =
    decision.disposition === 'apply' && !orphan.success && !opts.applyNonSuccess;

  const reason = withheldForOutcome
    ? ('non_success_not_applied' as const)
    : decision.disposition === 'hold'
    ? decision.reason
    : null;

  recordWiretapEvent('payment.orphan.decision', {
    disposition: reason ? 'hold' : 'apply',
    reason: reason ?? '(applied)',
    orphanOrderId: orphan.orderId ?? '(none)',
    currentOrderId,
    voucherNo: orphan.voucherNo ?? '(none)',
    outcomeKind: orphan.outcomeKind ?? '(none)',
  });

  if (!reason) {
    /**
     * #344 ruling 4. Applied, so this attempt now OWNS the payload — the caller settles the order
     * with it. Clear the native record only now, and only this one.
     */
    await releasePeekedOrphan(orphan);
    return orphan;
  }

  await holdOrphanPayment({
    orphanOrderId: orphan.orderId ?? '',
    seenWhileChargingOrderId: currentOrderId,
    reason,
    voucherNo: orphan.voucherNo,
    businessOrderNo: orphan.businessOrderNo,
    outcomeKind: orphan.outcomeKind,
    heldAt: new Date().toISOString(),
  });

  /**
   * #344 ruling 4 — CLEAR ONLY AFTER THE HOLD IS DURABLE. This ordering is the entire fix: the
   * native record is the only copy until holdOrphanPayment returns, so clearing before it (which
   * is what the old destructive consume did implicitly) loses a card transaction on any crash in
   * between. Read, hold, then clear.
   *
   * If the hold silently failed — it is best-effort and cannot throw — the clear below still runs,
   * because the alternative is re-reading the same orphan on every payment forever. That trade is
   * deliberate and it is the one remaining lossy path; the storage write failing is the trigger,
   * and it is logged.
   */
  await releasePeekedOrphan(orphan);
  return null;
}

export async function consumeOrphanedIfAny(): Promise<PaymentResult | null> {
  /**
   * #344 ruling 4. PREFER THE NON-DESTRUCTIVE PEEK. The record is then cleared by
   * releasePeekedOrphan only after the payload is durably held or applied, so a crash in between
   * no longer loses a card transaction.
   *
   * The destructive consume remains as a FALLBACK, and deliberately so: a JS bundle can outlive
   * the APK it shipped with, and on an older APK peek does not exist. Falling back reads the
   * orphan with the old window rather than not reading it at all — the window is the bug, but
   * silently ignoring the orphan would be a worse one.
   */
  const read =
    PaymentModule?.peekOrphanedPaymentResult ??
    PaymentModule?.consumeOrphanedPaymentResult;
  if (!read) {
    return null;
  }
  try {
    const orphaned = await read();
    if (!orphaned) {
      return null;
    }
    console.warn('[payment] Recovered orphaned Finatic SALE callback', orphaned);
    if (orphaned.outcome === 'success' || String(orphaned.voucherNo ?? '').trim()) {
      return mapNativeSuccess({...orphaned, orphaned: true});
    }
    const businessOrderNo =
      String(orphaned.businessOrderNo ?? '').trim() ||
      String(orphaned.merchantOrderNo ?? '').trim() ||
      undefined;
    // #344. The order native recorded at launch, so the guard can compare it.
    const orphanOrderId = String(orphaned.orderId ?? '').trim() || undefined;
    const receiptToken = String(orphaned.receiptToken ?? '').trim() || undefined;
    if (orphaned.outcome === 'user_cancelled') {
      return {
        success: false,
        orphaned: true,
        outcomeKind: 'user_cancelled',
        businessOrderNo,
        orderId: orphanOrderId,
        receiptToken,
        gatewayResult: orphaned.gatewayResult,
        error: orphaned.error || 'Payment was cancelled on the reader before the gateway was contacted',
      };
    }
    return {
      success: false,
      orphaned: true,
      outcomeKind: 'orphaned_ambiguous',
      businessOrderNo,
      orderId: orphanOrderId,
      receiptToken,
      error:
        orphaned.error ||
        'Payment callback was delivered without an active JS promise — outcome unconfirmed by device',
    };
  } catch (err) {
    console.warn('[payment] consumeOrphanedPaymentResult failed', err);
    return null;
  }
}

export async function processPaymentIntent(
  amount: number,
  orderId: string,
): Promise<PaymentResult> {
  if (Platform.OS !== 'android' || !PaymentModule?.launchPayment) {
    return {
      success: false,
      outcomeKind: 'confirmed_failure',
      error: 'Payment module not available on this platform',
    };
  }

  // Recover a prior orphaned callback before starting a new SALE (process death case).
  //
  // #344 SITE 1 OF 2. Guarded by applyOrHoldOrphan: an orphan is applied ONLY when it names this
  // order. Anything else is held, never discarded, and this payment proceeds normally.
  const priorOrphan = await consumeOrphanedIfAny();
  //
  // #344 RULING 5. The `.success` gate is GONE. A non-success orphan is still never applied at
  // this site (see applyOrHoldOrphan: applyNonSuccess is false here, because the operator is
  // starting a fresh payment) — but it is now HELD with its outcome instead of being consumed and
  // silently dropped, which is what this branch used to do to every cancel and every ambiguous
  // result that reached a reader.
  if (priorOrphan) {
    const applied = await applyOrHoldOrphan(priorOrphan, orderId, {
      applyNonSuccess: false,
    });
    if (applied) {
      return applied;
    }
  }

  try {
    const token = await getTerminalToken();
    if (!token) {
      return {success: false, outcomeKind: 'confirmed_failure', error: 'Session expired'};
    }

    const prepareOrderId = resolvePrepareOrderId(orderId);

    // Persist backend-owned merchant_order_no before Finatic so webhooks can correlate.
    const prepared = await prepareTerminalPayment(prepareOrderId, token);
    const merchantOrderNo = prepared.merchantOrderNo;

    const amountInCents = String(Math.round(amount * 100));

    // launchPayment's Promise only resolves when WiseCashier returns. Start it
    // first so native startActivityForResult runs, then mark attempt-started
    // before awaiting the payment outcome (handoff: fire at launch, not result).
    const launchPromise = PaymentModule.launchPayment(
      amountInCents,
      orderId,
      merchantOrderNo,
    );

    await notifyPaymentAttemptStarted(prepareOrderId, token, merchantOrderNo);

    /**
     * #346 — THE PROMISE NOW HAS A CEILING. It never did: if WiseCashier never returned, this
     * awaited forever and the screen sat on "PROCESSING / Please wait..." with no end.
     *
     * THE TIMEOUT MUST NOT ABANDON THE PAYMENT, and this is the whole difficulty. WiseCashier is a
     * separate activity still holding the card; the reader can settle seconds after we stop
     * waiting. Two consequences shape the code below:
     *
     *   1. The outcome is 'ambiguous', NEVER a failure. A failure would tell the server this sale
     *      did not happen, and the server would act on that while the card was being charged. The
     *      server's answer to ambiguous is to verify against Finatic, which is exactly right.
     *
     *   2. THE LATE RESULT IS CAUGHT, not dropped. Racing a promise does not cancel the loser: when
     *      WiseCashier finally returns, launchPromise resolves into nothing and a real card
     *      transaction disappears — the same class of loss as the destructive consume that ruling 4
     *      removed. So on timeout we attach a handler that routes whatever arrives into the #344
     *      held store, where the reporting pass will settle it against the order it names.
     *
     * Native's orphan store covers the case where the whole process dies; this covers the case
     * where it does not. They are different failures and both need an owner.
     */
    const TIMED_OUT = Symbol('payment-result-timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      launchPromise,
      new Promise<typeof TIMED_OUT>(resolve => {
        timeoutHandle = setTimeout(() => resolve(TIMED_OUT), PAYMENT_RESULT_TIMEOUT_MS);
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (raced === TIMED_OUT) {
      recordWiretapEvent('payment.result.timeout', {
        orderId,
        businessOrderNo: merchantOrderNo,
        waitedMs: String(PAYMENT_RESULT_TIMEOUT_MS),
      });
      // Catch the late arrival. Deliberately not awaited: this function returns now, and the
      // handler outlives it for as long as the JS context does.
      void launchPromise
        .then(async late => {
          const mapped = mapNativeSuccess({
            ...late,
            businessOrderNo: late.businessOrderNo || merchantOrderNo,
          });
          recordWiretapEvent('payment.result.late', {
            orderId,
            businessOrderNo: mapped.businessOrderNo ?? merchantOrderNo,
            outcomeKind: mapped.outcomeKind ?? '(none)',
            success: String(mapped.success),
          });
          // applyNonSuccess:false — nobody is waiting on this screen any more, so nothing may be
          // applied to whatever the operator has moved on to. Held, reported, never dropped.
          await applyOrHoldOrphan({...mapped, orderId}, '', {applyNonSuccess: false});
        })
        .catch(err => {
          recordWiretapEvent('payment.result.late', {
            orderId,
            businessOrderNo: merchantOrderNo,
            outcomeKind: '(threw)',
            success: 'false',
            error: err instanceof Error ? err.message : String(err),
          });
        });

      return {
        success: false,
        outcomeKind: 'ambiguous',
        businessOrderNo: merchantOrderNo,
        error: PAYMENT_TIMED_OUT_MESSAGE,
      };
    }

    const result = raced;

    // Native MainActivity only resolves on Finatic result "00" with a transaction ID.
    return mapNativeSuccess({
      ...result,
      businessOrderNo: result.businessOrderNo || merchantOrderNo,
    });
  } catch (error: unknown) {
    // After a lost Promise, the native side may have persisted an orphaned result.
    //
    // #344 SITE 2 OF 2, and it was the more exposed of the two: it returned the orphan with no
    // order check AND no `.success` test at all. Being inside the catch for THIS order's payment
    // makes an orphan found here MORE LIKELY to belong to this order — but likelihood is not the
    // standard on a payment path, and an orphan left unconsumed by an earlier sale reaches this
    // line identically. Same three cases as site 1.
    const orphaned = await consumeOrphanedIfAny();
    if (orphaned) {
      // applyNonSuccess: TRUE here and false at site 1 — see applyOrHoldOrphan. A matching
      // user_cancelled MUST be applied here or #183 returns: it falls through to ambiguous, the
      // server verifies against a gateway with no record, and the order strands on E04111.
      const applied = await applyOrHoldOrphan(orphaned, orderId, {
        applyNonSuccess: true,
      });
      if (applied) {
        return applied;
      }
    }

    const message =
      error instanceof Error ? error.message : 'Payment failed';
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as {code?: string}).code ?? '')
        : '';

    // Native embeds the raw gateway code as "gateway result=XYZ)" in both the ambiguous
    // and PAYMENT_DECLINED messages — pull it out so it can ride along in the audit ref.
    const gatewayResult = extractGatewayResult(message);

    // Native rejects a known decline code (see MainActivity's KNOWN_DECLINE_CODES) as
    // PAYMENT_DECLINED — that's a confirmed no-charge, safe to report without a Finatic
    // verify round-trip. Everything else non-"00" is PAYMENT_AMBIGUOUS (not a confirmed
    // decline) and must go through Finatic verify before being treated as failed.
    // Checked FIRST, on the native error CODE only, and returned before the message-text regex
    // below can see it. That regex is the fragility this fix removes -- it must not be able to
    // reclassify a user cancel by wording. Native raises this ONLY on Activity.RESULT_CANCELED.
    if (code === 'PAYMENT_CANCELLED_BY_USER') {
      return {
        success: false,
        outcomeKind: 'user_cancelled',
        error: message || 'Payment cancelled on the reader',
        gatewayResult,
      };
    }

    const ambiguous =
      code === 'PAYMENT_AMBIGUOUS' ||
      code === 'PAYMENT_FAILED' ||
      /unconfirmed|ambiguous|no transaction id|not a confirmed success|cancelled or returned/i.test(
        message,
      );

    return {
      success: false,
      outcomeKind: ambiguous ? 'ambiguous' : 'confirmed_failure',
      error: ambiguous
        ? message || 'Payment outcome unconfirmed by device'
        : message,
      gatewayResult,
    };
  }
}

/**
 * After an ambiguous / failed device callback, ask the backend to query Finatic
 * before we report failure. If Finatic says paid, return a success-shaped result
 * the caller can feed into completePayment(success).
 */
export async function resolveAmbiguousPaymentWithFinatic(
  orderId: string,
  prior: PaymentResult,
): Promise<PaymentResult> {
  try {
    const token = await getTerminalToken();
    if (!token) {
      return prior;
    }
    const verified = await verifyTerminalPayment(orderId, token);
    if (verified.paid) {
      const voucherNo =
        String(verified.transactionId ?? '').trim() ||
        String(prior.voucherNo ?? '').trim() ||
        String(verified.merchantOrderNo ?? '').trim() ||
        undefined;
      const businessOrderNo =
        String(verified.merchantOrderNo ?? '').trim() ||
        String(prior.businessOrderNo ?? '').trim() ||
        undefined;
      if (!voucherNo) {
        return {
          ...prior,
          success: false,
          outcomeKind: 'ambiguous',
          error:
            'Finatic reports paid but no transaction id was returned — cannot mark paid safely',
        };
      }
      console.warn('[payment] Finatic verify recovered paid sale after ambiguous device callback', {
        orderId,
        voucherNo,
        businessOrderNo,
        source: verified.source,
      });
      return {
        success: true,
        reference: voucherNo,
        voucherNo,
        businessOrderNo,
        outcomeKind: 'success',
      };
    }
    return {
      ...prior,
      success: false,
      outcomeKind: prior.outcomeKind ?? 'ambiguous',
      businessOrderNo:
        prior.businessOrderNo ||
        (verified.merchantOrderNo ? String(verified.merchantOrderNo) : undefined),
      error:
        prior.error ||
        `Payment not confirmed by Finatic (status=${verified.status ?? 'unknown'})`,
    };
  } catch (err) {
    console.warn('[payment] verifyTerminalPayment failed', err);
    return {
      ...prior,
      success: false,
      outcomeKind: 'ambiguous',
      error:
        prior.error ||
        (err instanceof Error
          ? err.message
          : 'Could not verify payment status with Finatic'),
    };
  }
}

export function unconfirmedFailureReference(): string {
  return `${UNCONFIRMED_PAYMENT_REF_PREFIX}${Date.now()}`;
}

export function declinedFailureReference(gatewayResult?: string): string {
  const code = gatewayResult?.trim();
  return `${DECLINED_PAYMENT_REF_PREFIX}${code ? `${code}-` : ''}${Date.now()}`;
}

export async function processRefundIntent(
  amount: number,
  originBusinessOrderNo: string,
): Promise<RefundResult> {
  if (Platform.OS !== 'android' || !PaymentModule?.launchRefund) {
    return {
      status: 'FAILED',
      retryable: false,
      gateway: {
        code: 'MODULE_UNAVAILABLE',
        message: 'Payment module not available on this platform',
      },
    };
  }
  try {
    const amountInCents = String(Math.round(amount * 100));
    const result = await PaymentModule.launchRefund(
      amountInCents,
      originBusinessOrderNo,
    );
    return result;
  } catch (error: unknown) {
    return {
      status: 'FAILED',
      retryable: false,
      gateway: {
        code: 'NATIVE_ERROR',
        message: error instanceof Error ? error.message : 'Refund failed',
      },
    };
  }
}
