import {NativeModules, Platform} from 'react-native';
import {APP_VERSION} from '../constants';
import {
  markTerminalPaymentAttemptStarted,
  prepareTerminalPayment,
  verifyTerminalPayment,
} from './api';
import {getTerminalToken} from './storage';

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

  if (!voucherNo) {
    return {
      success: false,
      businessOrderNo,
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
    reference: voucherNo,
    orphaned: Boolean(result.orphaned),
    outcomeKind: result.orphaned ? 'orphaned_success' : 'success',
  };
}

async function consumeOrphanedIfAny(): Promise<PaymentResult | null> {
  if (!PaymentModule?.consumeOrphanedPaymentResult) {
    return null;
  }
  try {
    const orphaned = await PaymentModule.consumeOrphanedPaymentResult();
    if (!orphaned) {
      return null;
    }
    console.warn('[payment] Recovered orphaned Finatic SALE callback', orphaned);
    if (orphaned.outcome === 'success' || String(orphaned.voucherNo ?? '').trim()) {
      return mapNativeSuccess({...orphaned, orphaned: true});
    }
    return {
      success: false,
      orphaned: true,
      outcomeKind: 'orphaned_ambiguous',
      businessOrderNo:
        String(orphaned.businessOrderNo ?? '').trim() ||
        String(orphaned.merchantOrderNo ?? '').trim() ||
        undefined,
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
  const priorOrphan = await consumeOrphanedIfAny();
  if (priorOrphan?.success) {
    const orphanOrderId = // set on orphaned payload
      undefined;
    // Prefer applying orphan only when it matches this order (or order id unknown).
    return priorOrphan;
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

    const result = await launchPromise;

    // Native MainActivity only resolves on Finatic result "00" with a transaction ID.
    return mapNativeSuccess({
      ...result,
      businessOrderNo: result.businessOrderNo || merchantOrderNo,
    });
  } catch (error: unknown) {
    // After a lost Promise, the native side may have persisted an orphaned result.
    const orphaned = await consumeOrphanedIfAny();
    if (orphaned) {
      return orphaned;
    }

    const message =
      error instanceof Error ? error.message : 'Payment failed';
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as {code?: string}).code ?? '')
        : '';

    // Native embeds the raw gateway code as "gateway result=XYZ)" in both the ambiguous
    // and PAYMENT_DECLINED messages — pull it out so it can ride along in the audit ref.
    const gatewayResult = message.match(/gateway result=(\S+)\)/i)?.[1];

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
