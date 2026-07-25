import {NativeModules, Platform} from 'react-native';
import {prepareTerminalPayment} from './api';
import {getTerminalToken} from './storage';

export interface PaymentResult {
  success: boolean;
  /** Preferred gateway ref for completePayment / settleTab (voucherNo first). */
  reference?: string;
  voucherNo?: string;
  businessOrderNo?: string;
  error?: string;
}

interface PaymentNativeResult {
  voucherNo?: string;
  businessOrderNo?: string;
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
}

const {PaymentModule} = NativeModules as {PaymentModule?: PaymentModuleType};

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

export async function processPaymentIntent(
  amount: number,
  orderId: string,
): Promise<PaymentResult> {
  if (Platform.OS !== 'android' || !PaymentModule?.launchPayment) {
    return {
      success: false,
      error: 'Payment module not available on this platform',
    };
  }

  try {
    const token = await getTerminalToken();
    if (!token) {
      return {success: false, error: 'Session expired'};
    }

    const prepareOrderId = resolvePrepareOrderId(orderId);

    // Persist backend-owned merchant_order_no before Finatic so webhooks can correlate.
    const prepared = await prepareTerminalPayment(prepareOrderId, token);
    const merchantOrderNo = prepared.merchantOrderNo;

    const amountInCents = String(Math.round(amount * 100));

    const result = await PaymentModule.launchPayment(
      amountInCents,
      orderId,
      merchantOrderNo,
    );

    const voucherNo = String(result.voucherNo ?? '').trim() || undefined;
    // Prefer the value we sent (and persisted); fall back to gateway echo.
    const businessOrderNo =
      merchantOrderNo ||
      String(result.businessOrderNo ?? '').trim() ||
      undefined;

    // Native MainActivity only resolves on Finatic result "00" with a transaction ID.
    // Refuse to mark success without a voucher — never invent FT-* references.
    if (!voucherNo) {
      return {
        success: false,
        businessOrderNo,
        error: 'No transaction ID returned from payment app',
      };
    }

    return {
      success: true,
      voucherNo,
      businessOrderNo,
      reference: voucherNo,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
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
