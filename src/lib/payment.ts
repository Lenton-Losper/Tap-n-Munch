import {NativeModules, Platform} from 'react-native';

export interface PaymentResult {
  success: boolean;
  reference?: string;
  error?: string;
}

interface PaymentNativeResult {
  voucherNo?: string;
  businessOrderNo?: string;
}

interface PaymentModuleType {
  launchPayment: (amount: string, orderId: string) => Promise<PaymentNativeResult>;
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

    return {
      success: true,
      reference:
        result.voucherNo ||
        result.businessOrderNo ||
        `FT-${Date.now()}`,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
}
