import {
  getPrinterConfig,
  getReceiptForOrder,
  recordReceiptDelivery,
  TerminalPrinterConfig,
} from './api';
import {connectToPrinter, getPrinterStatus, printEscPosBytes} from './printer';
import {getTerminalId} from './storage';
import {printBuiltInJob} from './wiseSdk6Printer';

export interface PrintReceiptResult {
  success: boolean;
  /** Distinguishes "no printer configured yet" / "receipt not issued yet" from a real print failure. */
  errorCode?: string;
  error?: string;
}

/**
 * Fetches the issued receipt for an order and prints it on the terminal's configured printer
 * (Bluetooth ESC/POS or the P5's built-in WiseSDK6 printer), logging the attempt to
 * receipt_deliveries either way. Never throws -- a failed print must never be treated as a
 * payment failure, so every failure mode resolves to { success: false, errorCode, error } for
 * the caller to show as "Retry / Skip".
 */
export async function printReceiptForOrder(
  orderId: string,
  token: string,
): Promise<PrintReceiptResult> {
  const config = await getPrinterConfig(token).catch(() => null);
  if (!config) {
    return {
      success: false,
      errorCode: 'NO_PRINTER_CONFIGURED',
      error: 'No receipt printer is set up on this terminal',
    };
  }

  if (config.connection_type === 'BUILTIN') {
    return printViaBuiltIn(orderId, token);
  }
  return printViaBluetooth(config, orderId, token);
}

async function printViaBluetooth(
  config: TerminalPrinterConfig,
  orderId: string,
  token: string,
): Promise<PrintReceiptResult> {
  if (!config.printer_address) {
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
          provider: 'bluetooth_escpos',
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
      provider: 'bluetooth_escpos',
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

async function printViaBuiltIn(orderId: string, token: string): Promise<PrintReceiptResult> {
  const receipt = await getReceiptForOrder(orderId, token).catch(() => null);
  if (!receipt) {
    return {
      success: false,
      errorCode: 'RECEIPT_NOT_READY',
      error: 'Receipt has not been issued yet',
    };
  }

  const deviceId = (await getTerminalId()) ?? undefined;

  // sdk6Lines is optional on the type (older/cached responses may omit it) -- fail closed
  // rather than guess at receipt content client-side, but still log the attempt so it's
  // visible in receipt_deliveries.
  if (!receipt.sdk6Lines) {
    await recordReceiptDelivery(
      {
        receiptDocumentId: receipt.id,
        status: 'failed',
        provider: 'wiseasy_sdk6',
        deviceId,
        errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
        errorMessage: 'Built-in printer receipt format is not available for this receipt',
      },
      token,
    );
    return {
      success: false,
      errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
      error: 'Receipt printing via the built-in printer is not available for this receipt',
    };
  }

  const printResult = await printBuiltInJob(receipt.sdk6Lines);

  await recordReceiptDelivery(
    {
      receiptDocumentId: receipt.id,
      status: printResult.success ? 'sent' : 'failed',
      provider: 'wiseasy_sdk6',
      deviceId,
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
