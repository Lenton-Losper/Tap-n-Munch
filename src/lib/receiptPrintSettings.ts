import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RECEIPT_PRINT_LAST_RESULT_KEY,
  RECEIPT_PRINTING_ENABLED_KEY,
} from '../constants';

export type LastPrintOutcome = 'success' | 'failed' | 'none';

export interface LastPrintResult {
  outcome: LastPrintOutcome;
  at: string;
  source: 'receipt' | 'test' | 'reprint';
  errorCode?: string;
  errorMessage?: string;
  printerLabel?: string;
}

/**
 * Staff-facing print errors only — never surface raw SDK / exception text.
 * Keep messages short for restaurant terminals.
 */
const STAFF_PRINT_ERRORS: Record<string, string> = {
  OUT_OF_PAPER: 'Out of paper',
  SDK_NOT_CONNECTED: 'Printer disconnected',
  CONNECT_FAILED: 'Printer disconnected',
  NOT_CONNECTED: 'Printer disconnected',
  BLUETOOTH_DISABLED: 'Printer disconnected',
  BLUETOOTH_UNAVAILABLE: 'Printer disconnected',
  PRINTER_NOT_FOUND: 'Printer disconnected',
  UNAVAILABLE: 'Printer unavailable',
  SDK_INIT_FAILED: 'Printer unavailable',
  STATUS_UNAVAILABLE: 'Printer unavailable',
  STATUS_FAILED: 'Printer unavailable',
  NO_PRINTER_CONFIGURED: 'Printer unavailable',
  BLUETOOTH_NOT_SUPPORTED: 'Printer unavailable',
  BLUETOOTH_PERMISSION_DENIED: 'Printer unavailable',
  UNSUPPORTED_PLATFORM: 'Printer unavailable',
  LOW_BATTERY: 'Low battery',
  PRINTER_OVERHEATED: 'Printer overheated',
  PRINT_FAILED: 'Printing failed',
  PRINT_TIMEOUT: 'Printer did not respond',
  PRINTER_ERROR: 'Printing failed',
  INVALID_PAYLOAD: 'Printing failed',
  RECEIPT_NOT_READY: 'Receipt not ready — try again',
  RECEIPT_FETCH_FAILED: 'Could not load receipt',
  RECEIPT_FORMAT_UNAVAILABLE: 'Receipt cannot be printed',
  PRINTING_DISABLED: 'Receipt printing is turned off',
};

/** Staff-facing message — ignores raw SDK fallbacks. */
export function describeReceiptPrintError(
  errorCode?: string,
  _fallbackMessage?: string,
): string {
  if (errorCode && STAFF_PRINT_ERRORS[errorCode]) {
    return STAFF_PRINT_ERRORS[errorCode];
  }
  return 'Printing failed';
}

export async function getReceiptPrintingEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(RECEIPT_PRINTING_ENABLED_KEY);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

export async function setReceiptPrintingEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(
    RECEIPT_PRINTING_ENABLED_KEY,
    enabled ? '1' : '0',
  );
}

export async function getLastPrintResult(): Promise<LastPrintResult | null> {
  try {
    const raw = await AsyncStorage.getItem(RECEIPT_PRINT_LAST_RESULT_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as LastPrintResult;
  } catch {
    return null;
  }
}

export async function recordLastPrintResult(
  result: Omit<LastPrintResult, 'at'> & {at?: string},
): Promise<void> {
  const payload: LastPrintResult = {
    ...result,
    at: result.at ?? new Date().toISOString(),
  };
  try {
    await AsyncStorage.setItem(
      RECEIPT_PRINT_LAST_RESULT_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Diagnostics only — never block printing.
  }
}

export async function clearReceiptPrintSettings(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(RECEIPT_PRINTING_ENABLED_KEY).catch(() => {}),
    AsyncStorage.removeItem(RECEIPT_PRINT_LAST_RESULT_KEY).catch(() => {}),
  ]);
}
