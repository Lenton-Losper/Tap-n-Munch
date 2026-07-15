import {NativeModules, Platform} from 'react-native';

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
  launchPayment: (amount: string, orderId: string) => Promise<PaymentNativeResult>;
  launchRefund: (
    amount: string,
    originBusinessOrderNo: string,
  ) => Promise<RefundNativeResult>;
}

const {PaymentModule} = NativeModules as {PaymentModule?: PaymentModuleType};

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
    const amountInCents = String(Math.round(amount * 100));

    const result = await PaymentModule.launchPayment(amountInCents, orderId);

    const voucherNo = result.voucherNo || undefined;
    const businessOrderNo = result.businessOrderNo || undefined;

    return {
      success: true,
      voucherNo,
      businessOrderNo,
      reference:
        voucherNo ||
        businessOrderNo ||
        `FT-${Date.now()}`,
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
