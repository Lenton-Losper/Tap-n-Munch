import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

export interface PrinterInfo {
  id: string;
  name: string;
}

export interface PrinterConnectResult {
  connected: boolean;
  id: string;
}

export interface PrinterStatus {
  connected: boolean;
  id: string | null;
}

export interface PrinterActionResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

interface PrinterModuleType {
  getPrinters: () => Promise<PrinterInfo[]>;
  connect: (printerId: string) => Promise<PrinterConnectResult>;
  printEscPos: (payloadBase64: string) => Promise<boolean>;
  getStatus: () => Promise<PrinterStatus>;
}

const {PrinterModule} = NativeModules as {PrinterModule?: PrinterModuleType};

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as {code?: unknown}).code)
    : undefined;
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const PLAIN_LANGUAGE_ERRORS: Record<string, string> = {
  BLUETOOTH_DISABLED:
    'Bluetooth is turned off. Turn it on in your device settings and try again.',
  BLUETOOTH_NOT_SUPPORTED: "This device doesn't support Bluetooth.",
  BLUETOOTH_PERMISSION_DENIED:
    'This app needs Bluetooth permission to find printers. Grant it in your device settings and try again.',
  BLUETOOTH_UNAVAILABLE: "Couldn't check for printers right now. Try again in a moment.",
  UNSUPPORTED_PLATFORM: 'Receipt printing is only available on this terminal app.',
  PRINTER_NOT_FOUND:
    "That printer is no longer available. Make sure it's still paired and try again.",
  CONNECT_FAILED: "Couldn't connect. Make sure the printer is powered on and in range.",
  NOT_CONNECTED: 'No printer is connected.',
  PRINT_FAILED:
    'The print failed partway through. Make sure the printer is powered on and in range.',
  INVALID_PAYLOAD: 'Something went wrong preparing that print job.',
  NO_PRINTER_CONFIGURED: 'No receipt printer is set up on this device yet.',
  RECEIPT_NOT_READY: "The receipt isn't ready yet. Wait a moment and try again.",
};

/** Maps a native/API error code to a plain-language message a non-technical user can act on. */
export function describePrinterError(errorCode?: string, fallbackMessage?: string): string {
  if (errorCode && PLAIN_LANGUAGE_ERRORS[errorCode]) {
    return PLAIN_LANGUAGE_ERRORS[errorCode];
  }
  return fallbackMessage || 'Something went wrong with the printer. Please try again.';
}

/**
 * Paired-device lookup only (no active scanning), so on API 31+ only BLUETOOTH_CONNECT is
 * strictly required; BLUETOOTH_SCAN is requested too for completeness since some OEM builds
 * still gate bonded-device enumeration behind it.
 */
async function ensureBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Platform.Version < 31) return true;

  try {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    ]);
    return (
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
        PermissionsAndroid.RESULTS.GRANTED &&
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
        PermissionsAndroid.RESULTS.GRANTED
    );
  } catch {
    return false;
  }
}

export interface ListPrintersResult {
  printers: PrinterInfo[];
  /** Set when printers is empty because of a real failure, not just "nothing paired". */
  errorCode?: string;
  error?: string;
}

/**
 * Distinguishes *why* the list came back empty -- "Bluetooth is off", "no permission", and
 * "Bluetooth is on but nothing is paired" all look the same as a bare empty array, but need
 * different plain-language messages in the UI.
 */
export async function listPairedPrinters(): Promise<ListPrintersResult> {
  if (Platform.OS !== 'android' || !PrinterModule?.getPrinters) {
    return {
      printers: [],
      errorCode: 'UNSUPPORTED_PLATFORM',
      error: 'Receipt printing is only available on this terminal app',
    };
  }

  const granted = await ensureBluetoothPermissions();
  if (!granted) {
    return {
      printers: [],
      errorCode: 'BLUETOOTH_PERMISSION_DENIED',
      error: 'Bluetooth permission is required to find printers',
    };
  }

  try {
    const printers = await PrinterModule.getPrinters();
    return {printers};
  } catch (error: unknown) {
    return {
      printers: [],
      errorCode: errorCodeOf(error),
      error: errorMessageOf(error, 'Failed to list paired printers'),
    };
  }
}

export async function connectToPrinter(
  printerId: string,
): Promise<PrinterActionResult> {
  if (Platform.OS !== 'android' || !PrinterModule?.connect) {
    return {success: false, error: 'Printer module not available on this platform'};
  }
  try {
    await PrinterModule.connect(printerId);
    return {success: true};
  } catch (error: unknown) {
    return {
      success: false,
      error: errorMessageOf(error, 'Failed to connect to printer'),
      errorCode: errorCodeOf(error),
    };
  }
}

/** Sends already-rendered ESC/POS bytes (base64) to the currently connected printer. */
export async function printEscPosBytes(
  escposBase64: string,
): Promise<PrinterActionResult> {
  if (Platform.OS !== 'android' || !PrinterModule?.printEscPos) {
    return {success: false, error: 'Printer module not available on this platform'};
  }
  try {
    await PrinterModule.printEscPos(escposBase64);
    return {success: true};
  } catch (error: unknown) {
    return {
      success: false,
      error: errorMessageOf(error, 'Print failed'),
      errorCode: errorCodeOf(error),
    };
  }
}

export async function getPrinterStatus(): Promise<PrinterStatus> {
  if (Platform.OS !== 'android' || !PrinterModule?.getStatus) {
    return {connected: false, id: null};
  }
  try {
    return await PrinterModule.getStatus();
  } catch {
    return {connected: false, id: null};
  }
}
