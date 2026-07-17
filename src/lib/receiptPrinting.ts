import {
  getPrinterConfig,
  getReceiptForOrder,
  recordReceiptDelivery,
} from './api';
import {connectToPrinter, getPrinterStatus, printEscPosBytes} from './printer';

export interface PrintReceiptResult {
  success: boolean;
  /** Distinguishes "no printer paired yet" / "receipt not issued yet" from a real print failure. */
  errorCode?: string;
  error?: string;
}

/**
 * Fetches the issued receipt for an order and prints it on the terminal's configured
 * Bluetooth printer, logging the attempt to receipt_deliveries either way. Never throws —
 * a failed print must never be treated as a payment failure, so every failure mode resolves
 * to { success: false, errorCode, error } for the caller to show as "Retry / Skip".
 */
export async function printReceiptForOrder(
  orderId: string,
  token: string,
): Promise<PrintReceiptResult> {
  const config = await getPrinterConfig(token).catch(() => null);
  if (!config?.printer_address) {
    return {
      success: false,
      errorCode: 'NO_PRINTER_CONFIGURED',
      error: 'No receipt printer is paired with this terminal',
    };
  }

  const receipt = await getReceiptForOrder(
    orderId,
    token,
    config.character_width ?? undefined,
  ).catch(() => null);
  if (!receipt) {
    return {
      success: false,
      errorCode: 'RECEIPT_NOT_READY',
      error: 'Receipt has not been issued yet',
    };
  }

  const status = await getPrinterStatus();
  if (!status.connected || status.id !== config.printer_address) {
    const connectResult = await connectToPrinter(config.printer_address);
    if (!connectResult.success) {
      await recordReceiptDelivery(
        {
          receiptDocumentId: receipt.id,
          status: 'failed',
          errorCode: connectResult.errorCode,
          errorMessage: connectResult.error,
        },
        token,
      );
      return {
        success: false,
        errorCode: connectResult.errorCode,
        error: connectResult.error ?? 'Failed to connect to printer',
      };
    }
  }

  const printResult = await printEscPosBytes(receipt.escposBase64);

  await recordReceiptDelivery(
    {
      receiptDocumentId: receipt.id,
      status: printResult.success ? 'sent' : 'failed',
      errorCode: printResult.errorCode,
      errorMessage: printResult.error,
    },
    token,
  );

  if (!printResult.success) {
    return {
      success: false,
      errorCode: printResult.errorCode,
      error: printResult.error ?? 'Failed to print receipt',
    };
  }

  return {success: true};
}
