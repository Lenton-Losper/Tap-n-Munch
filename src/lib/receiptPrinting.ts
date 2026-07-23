import {
  getPrinterConfig,
  getReceiptForOrder,
  recordReceiptDelivery,
  sendReceiptEmail,
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
  let config: TerminalPrinterConfig | null = null;
  let configFetchError: unknown;
  try {
    config = await getPrinterConfig(token);
  } catch (err) {
    configFetchError = err;
  }

  if (!config) {
    // No adb/on-device log access on this hardware -- route the diagnostic through
    // receipt_deliveries.error_message instead (queryable on staging via Supabase), same as
    // every other failure here. "No receipt printer is set up on this terminal" is the *only*
    // place that exact string appears client-side (confirmed by grepping every printer_address
    // check), so there is no separate client-side gate blocking BUILTIN configs -- this is
    // either the GET route not returning the saved row, returning it without connection_type,
    // or the request failing outright, and this is what will tell us which.
    const receipt = await getReceiptForOrder(orderId, token).catch(() => null);
    if (receipt) {
      await recordReceiptDelivery(
        {
          receiptDocumentId: receipt.id,
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

export interface SendReceiptEmailResult {
  success: boolean;
  error?: string;
}

/**
 * Emails the receipt for an order, fetching it first so a failure has a receiptDocumentId to
 * log against. On failure, routes the raw response (see sendReceiptEmail's full status+body
 * error) into receipt_deliveries.error_message -- no on-device log access on this hardware, so
 * this is the only way to see what the route actually returned. NOTE: the email route is
 * assumed (not confirmed) to log its own receipt_deliveries row server-side on send, so a
 * failed attempt may end up with two rows (this one and the server's) until that's confirmed
 * either way -- accepted since the diagnostic need outweighs a possible duplicate row. Does not
 * log on success (the low-risk/lower-priority half of this per the request that added it).
 */
export async function sendReceiptEmailForOrder(
  orderId: string,
  email: string,
  token: string,
): Promise<SendReceiptEmailResult> {
  const receipt = await getReceiptForOrder(orderId, token).catch(() => null);
  if (!receipt) {
    return {success: false, error: 'Receipt has not been issued yet'};
  }

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
