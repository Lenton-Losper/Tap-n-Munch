import {
  getPrinterConfig,
  getReceiptForOrder,
  ReceiptNotReadyError,
  recordReceiptDelivery,
  sendReceiptEmail,
  TerminalPrinterConfig,
  TerminalReceipt,
} from './api';
import {paperTypeFromWidthMm} from './paperWidth';
import {runBluetoothPrintJob} from './printer';
import {
  describeReceiptPrintError,
  getReceiptPrintingEnabled,
  recordLastPrintResult,
} from './receiptPrintSettings';
import {getTerminalId} from './storage';
import {printBuiltInJob, Sdk6ReceiptLine} from './wiseSdk6Printer';

export interface PrintReceiptResult {
  success: boolean;
  /** Distinguishes config / issuance / transport failures for Retry-Skip UX. */
  errorCode?: string;
  error?: string;
}

const RECEIPT_NOT_READY_MAX_ATTEMPTS = 3;
const RECEIPT_NOT_READY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeReceiptNotReady(err: ReceiptNotReadyError): string {
  // Delivery-log / internal detail — staff UI uses describeReceiptPrintError instead.
  const paymentStatus = err.diagnostics?.paymentStatus ?? err.diagnostics?.payment_status;
  if (paymentStatus != null) {
    return `Receipt was not issued after payment (status: ${String(paymentStatus)}). Try again or contact support.`;
  }
  return 'Receipt was not issued after payment. Try again or contact support.';
}

function isUsableSdk6Lines(lines: Sdk6ReceiptLine[] | undefined): lines is Sdk6ReceiptLine[] {
  return Array.isArray(lines) && lines.length > 0;
}

async function fetchIssuedReceipt(
  orderId: string,
  token: string,
  characterWidth?: number,
): Promise<{receipt?: TerminalReceipt; notReady?: ReceiptNotReadyError; error?: string}> {
  let lastNotReady: ReceiptNotReadyError | undefined;

  for (let attempt = 1; attempt <= RECEIPT_NOT_READY_MAX_ATTEMPTS; attempt++) {
    try {
      const receipt = await getReceiptForOrder(orderId, token, characterWidth);
      return {receipt};
    } catch (err) {
      if (err instanceof ReceiptNotReadyError) {
        lastNotReady = err;
        if (attempt < RECEIPT_NOT_READY_MAX_ATTEMPTS) {
          await sleep(RECEIPT_NOT_READY_DELAY_MS);
          continue;
        }
        return {notReady: err};
      }
      return {
        error: err instanceof Error ? err.message : 'Failed to fetch receipt',
      };
    }
  }

  return lastNotReady ? {notReady: lastNotReady} : {error: 'Failed to fetch receipt'};
}

/**
 * Fetches the issued receipt for an order and prints it on the terminal's configured printer
 * (Bluetooth ESC/POS or the P5's built-in WiseSDK6 printer), logging the attempt to
 * receipt_deliveries when a receipt_document_id is available. Never throws -- a failed print
 * must never be treated as a payment failure. Never issues or mutates receipt documents.
 *
 * Backend contract (current): mark-paid awaits receipt issuance, so after a successful payment
 * GET /receipts/:orderId should return the final receipt. A RECEIPT_NOT_READY response is an
 * anomalous issuance failure, not an expected client-side race.
 *
 * @param source - Diagnostics label for last-print panel (default receipt / reprint).
 */
export async function printReceiptForOrder(
  orderId: string,
  token: string,
  source: 'receipt' | 'reprint' = 'receipt',
): Promise<PrintReceiptResult> {
  // Single source of truth: developer "Enable Receipt Printing" toggle.
  // Settings / Diagnostics Test Print does not call this function.
  const enabled = await getReceiptPrintingEnabled();
  if (!enabled) {
    return {
      success: false,
      errorCode: 'PRINTING_DISABLED',
      error: 'Printing failed',
    };
  }

  const {result, printerLabel} = await printReceiptForOrderInner(orderId, token);
  await recordLastPrintResult({
    outcome: result.success ? 'success' : 'failed',
    source,
    errorCode: result.errorCode,
    // Store staff-facing text for diagnostics panel (never raw SDK strings).
    errorMessage: result.success
      ? undefined
      : describeReceiptPrintError(result.errorCode),
    printerLabel,
  });
  return result;
}

async function printReceiptForOrderInner(
  orderId: string,
  token: string,
): Promise<{result: PrintReceiptResult; printerLabel?: string}> {
  let config: TerminalPrinterConfig | null = null;
  let configFetchError: unknown;
  try {
    config = await getPrinterConfig(token);
  } catch (err) {
    configFetchError = err;
  }

  if (!config) {
    // No adb/on-device log access on this hardware -- route the diagnostic through
    // receipt_deliveries.error_message instead when we have a receipt document id.
    const fetched = await fetchIssuedReceipt(orderId, token);
    if (fetched.receipt) {
      await recordReceiptDelivery(
        {
          receiptDocumentId: fetched.receipt.id,
          status: 'failed',
          provider: 'config_lookup_failed',
          errorCode: 'NO_PRINTER_CONFIGURED',
          errorMessage: configFetchError
            ? `getPrinterConfig threw: ${configFetchError instanceof Error ? configFetchError.message : String(configFetchError)}`
            : `getPrinterConfig returned: ${JSON.stringify(config)}`,
        },
        token,
      );
    }
    return {
      result: {
        success: false,
        errorCode: 'NO_PRINTER_CONFIGURED',
        error: 'No receipt printer is set up on this terminal',
      },
    };
  }

  const printerLabel =
    config.connection_type === 'BUILTIN'
      ? config.printer_name || 'Built-in printer'
      : config.printer_name || 'Bluetooth printer';

  if (config.connection_type === 'BUILTIN') {
    return {result: await printViaBuiltIn(config, orderId, token), printerLabel};
  }
  return {result: await printViaBluetooth(config, orderId, token), printerLabel};
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

  const fetched = await fetchIssuedReceipt(
    orderId,
    token,
    config.character_width ?? undefined,
  );
  if (fetched.notReady) {
    return {
      success: false,
      errorCode: 'RECEIPT_NOT_READY',
      error: describeReceiptNotReady(fetched.notReady),
    };
  }
  if (!fetched.receipt) {
    return {
      success: false,
      errorCode: 'RECEIPT_FETCH_FAILED',
      error: fetched.error ?? 'Failed to fetch receipt',
    };
  }
  const receipt = fetched.receipt;

  if (!receipt.escposBase64) {
    await recordReceiptDelivery(
      {
        receiptDocumentId: receipt.id,
        status: 'failed',
        provider: 'bluetooth_escpos',
        errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
        errorMessage: 'Receipt response is missing escposBase64',
      },
      token,
    );
    return {
      success: false,
      errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
      error: 'Receipt printing payload is incomplete for this receipt',
    };
  }

  const printResult = await runBluetoothPrintJob({
    printerAddress: config.printer_address,
    escposBase64: receipt.escposBase64,
  });

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

/**
 * Built-in P5 path: GET issued receipt → require sdk6Lines → WiseSdk6PrinterModule.printJob
 * (same native entry Settings Test Print uses via printBuiltInJob).
 */
async function printViaBuiltIn(
  config: TerminalPrinterConfig,
  orderId: string,
  token: string,
): Promise<PrintReceiptResult> {
  // #167: both of these come from the terminal's stored config. Before this, the built-in path
  // fetched the receipt at the backend's default character width and let a native constant pick
  // the paper width, so neither stored value had any effect.
  const fetched = await fetchIssuedReceipt(
    orderId,
    token,
    config.character_width ?? undefined,
  );
  if (fetched.notReady) {
    return {
      success: false,
      errorCode: 'RECEIPT_NOT_READY',
      error: describeReceiptNotReady(fetched.notReady),
    };
  }
  if (!fetched.receipt) {
    return {
      success: false,
      errorCode: 'RECEIPT_FETCH_FAILED',
      error: fetched.error ?? 'Failed to fetch receipt',
    };
  }
  const receipt = fetched.receipt;

  const deviceId = (await getTerminalId()) ?? undefined;

  if (!isUsableSdk6Lines(receipt.sdk6Lines)) {
    await recordReceiptDelivery(
      {
        receiptDocumentId: receipt.id,
        status: 'failed',
        provider: 'wiseasy_sdk6',
        deviceId,
        errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
        errorMessage:
          'Built-in printer requires non-empty sdk6Lines on the issued receipt (missing or empty)',
      },
      token,
    );
    return {
      success: false,
      errorCode: 'RECEIPT_FORMAT_UNAVAILABLE',
      error: 'Receipt printing via the built-in printer is not available for this receipt',
    };
  }

  const printResult = await printBuiltInJob(receipt.sdk6Lines, {
    paperType: paperTypeFromWidthMm(config.paper_width_mm),
  });

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

export interface SendReceiptEmailResult {
  success: boolean;
  error?: string;
}

/**
 * Emails the receipt for an order, fetching it first so a failure has a receiptDocumentId to
 * log against. On failure, routes the raw response into receipt_deliveries.error_message.
 */
export async function sendReceiptEmailForOrder(
  orderId: string,
  email: string,
  token: string,
): Promise<SendReceiptEmailResult> {
  const fetched = await fetchIssuedReceipt(orderId, token);
  if (fetched.notReady) {
    return {success: false, error: describeReceiptNotReady(fetched.notReady)};
  }
  if (!fetched.receipt) {
    return {success: false, error: fetched.error ?? 'Failed to fetch receipt'};
  }
  const receipt = fetched.receipt;

  try {
    await sendReceiptEmail(orderId, email, token);
    return {success: true};
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    await recordReceiptDelivery(
      {
        receiptDocumentId: receipt.id,
        status: 'failed',
        provider: 'email',
        errorMessage: rawMessage,
      },
      token,
    );
    return {success: false, error: 'Failed to send receipt email'};
  }
}
