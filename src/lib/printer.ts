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

export async function listPairedPrinters(): Promise<PrinterInfo[]> {
  if (Platform.OS !== 'android' || !PrinterModule?.getPrinters) {
    return [];
  }
  const granted = await ensureBluetoothPermissions();
  if (!granted) {
    return [];
  }
  try {
    return await PrinterModule.getPrinters();
  } catch (error) {
    console.warn('[printer] Failed to list paired printers', error);
    return [];
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
