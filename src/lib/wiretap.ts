import {NativeModules} from 'react-native';

/**
 * JS access to the native WiseCashier wiretap (PaymentModule, vc82+), rendered on Diagnostics.
 *
 * Kept in its own module rather than in payment.ts or api.ts so either can import it without a
 * cycle — api.ts records the outbound payment payload, and payment.ts owns the read side.
 *
 * Every function here is fire-and-forget and swallows its own errors. Instrumentation must not
 * be able to fail a payment; a missing log line is always better than a thrown exception in the
 * middle of the money path.
 */
const {PaymentModule} = NativeModules as {
  PaymentModule?: {
    recordWiretapEvent?: (event: string, detailJson: string) => Promise<boolean>;
  };
};

export function recordWiretapEvent(
  event: string,
  detail: Record<string, unknown>,
): void {
  try {
    if (!PaymentModule?.recordWiretapEvent) {
      return;
    }
    void PaymentModule.recordWiretapEvent(event, JSON.stringify(detail)).catch(
      () => undefined,
    );
  } catch {
    // Deliberately silent — see the module comment.
  }
}
