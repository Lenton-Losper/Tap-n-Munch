import {NativeModules, Platform} from 'react-native';
import {withPrintLock} from './printQueue';

export type Sdk6TextAlign = 'LEFT' | 'CENTER' | 'RIGHT';

/**
 * Matches the backend contract (GET /api/terminal/receipts/[orderId] -> sdk6Lines, derived
 * from the same issued receipt snapshot as escposBase64). After successful mark-paid, the
 * backend awaits issuance — printViaBuiltIn expects sdk6Lines on that GET.
 *
 * WisePosSdk's Printer has no raw-byte-write method (unlike Bluetooth ESC/POS) -- only
 * structured calls (addSingleText, addMultiText). WiseSdk6PrinterModule.kt executes this list
 * verbatim. Settings → Test Print calls the same printBuiltInJob() / printJob() entry with
 * locally built diagnostic lines (not a receipt_document). No qrCode/barCode variant -- the
 * backend doesn't emit them.
 */
export type Sdk6ReceiptLine =
  | {type: 'text'; text: string; align: Sdk6TextAlign; bold?: boolean; large?: boolean}
  | {type: 'row'; columns: string[]}
  | {type: 'feed'; lines: number}
  | {type: 'divider'};

export interface WiseSdk6PrintOptions {
  /** How far to feed the paper after printing finishes, in dots (Y-axis). Defaults to 30 natively. */
  feedAfterDots?: number;
}

export interface WiseSdk6Status {
  connected: boolean;
  hasPaper: boolean;
  /** True when status could not be read — do not treat as out-of-paper. */
  statusUnknown?: boolean;
}

interface WiseSdk6PrinterModuleType {
  isAvailable: () => Promise<boolean>;
  getStatus: () => Promise<WiseSdk6Status>;
  printJob: (lines: Sdk6ReceiptLine[], options: WiseSdk6PrintOptions) => Promise<boolean>;
  probeService?: () => Promise<{
    action: string;
    matchCount: number;
    matchAllCount?: number;
    model: string;
    sdkInt: number;
    targetSdk?: number;
    queryAllPackagesGranted?: boolean;
    packageVisibilityApplies?: boolean;
    summary: string;
    components: string[];
    services?: Array<{packageName: string; serviceName: string}>;
  }>;
  enumeratePrinterRelatedServices?: () => Promise<PrinterServiceEnumResult>;
  testRealInitPosSdk?: () => Promise<RealInitPosSdkResult>;
}

const {WiseSdk6PrinterModule} = NativeModules as {
  WiseSdk6PrinterModule?: WiseSdk6PrinterModuleType;
};

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as {code?: unknown}).code)
    : undefined;
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const PLAIN_LANGUAGE_ERRORS: Record<string, string> = {
  UNSUPPORTED_PLATFORM: 'Receipt printing is only available on this terminal app.',
  UNAVAILABLE: "This device doesn't have a built-in receipt printer.",
  SDK_INIT_FAILED:
    "Built-in printer service not available on this terminal (see details).",
  SDK_NOT_CONNECTED:
    "Printer service not connected. Force-stop other POS apps, reopen FlashTap, and try again.",
  OUT_OF_PAPER: 'The printer is out of paper. Load a new roll and try again.',
  PRINTER_OVERHEATED: 'The printer is too hot to print right now. Wait a moment and try again.',
  LOW_BATTERY: 'The terminal battery is too low to print. Charge the device and try again.',
  PRINTER_ERROR: 'The built-in printer reported an error. Try again.',
  STATUS_UNAVAILABLE: "Couldn't check the printer's status. Try again.",
  STATUS_FAILED: "Couldn't check the printer's status. Try again.",
  PRINT_FAILED: 'The print failed partway through. Try again.',
  PRINT_TIMEOUT: 'Printer did not respond. Try Test Print again.',
  RECEIPT_NOT_READY:
    'Receipt was not issued after payment. Try again or contact support.',
  RECEIPT_FETCH_FAILED: "Couldn't load the receipt. Check the connection and try again.",
  RECEIPT_FORMAT_UNAVAILABLE:
    'This receipt cannot be printed on the built-in printer. Contact support.',
};

/** Maps a native/API error code to a plain-language message a non-technical user can act on. */
export function describeWiseSdk6PrinterError(errorCode?: string, fallbackMessage?: string): string {
  if (errorCode && PLAIN_LANGUAGE_ERRORS[errorCode]) {
    return PLAIN_LANGUAGE_ERRORS[errorCode];
  }
  return fallbackMessage || 'Something went wrong with the printer. Please try again.';
}

export interface WiseSdk6ActionResult {
  success: boolean;
  error?: string;
  errorCode?: string;
}

/** Whether this device has a working built-in printer at all (some Wiseasy models don't). */
export async function isBuiltInPrinterAvailable(): Promise<boolean> {
  if (Platform.OS !== 'android' || !WiseSdk6PrinterModule?.isAvailable) return false;
  try {
    return await WiseSdk6PrinterModule.isAvailable();
  } catch {
    return false;
  }
}

export async function getBuiltInPrinterStatus(): Promise<WiseSdk6Status> {
  if (Platform.OS !== 'android' || !WiseSdk6PrinterModule?.getStatus) {
    return {connected: false, hasPaper: true, statusUnknown: true};
  }
  try {
    const status = await Promise.race([
      WiseSdk6PrinterModule.getStatus(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('status timeout')), 8000);
      }),
    ]);
    return {
      connected: !!status.connected,
      hasPaper: status.hasPaper !== false,
      statusUnknown: false,
    };
  } catch {
    // Never map a failed status read to "Out of paper" — that was misleading staff.
    return {connected: false, hasPaper: true, statusUnknown: true};
  }
}

/** Sends a pre-rendered sdk6Lines list (from the receipts endpoint) to the built-in printer. */
export async function printBuiltInJob(
  lines: Sdk6ReceiptLine[],
  options: WiseSdk6PrintOptions = {},
): Promise<WiseSdk6ActionResult> {
  if (Platform.OS !== 'android' || !WiseSdk6PrinterModule?.printJob) {
    return {success: false, error: 'Printer module not available on this platform'};
  }
  try {
    // withPrintLock enforces queue + hard timeouts (incl. stuck prior jobs).
    await withPrintLock(() => WiseSdk6PrinterModule.printJob(lines, options));
    return {success: true};
  } catch (error: unknown) {
    return {
      success: false,
      error: errorMessageOf(error, 'Print failed'),
      errorCode: errorCodeOf(error) ?? 'PRINT_FAILED',
    };
  }
}

export type UsdkAidlProbeResult = {
  action: string;
  matchCount: number;
  matchAllCount: number;
  model: string;
  sdkInt: number;
  targetSdk: number;
  queryAllPackagesGranted: boolean;
  packageVisibilityApplies: boolean;
  summary: string;
  services: Array<{packageName: string; serviceName: string}>;
};

export type EnumeratedServiceInfo = {
  packageName: string;
  serviceName: string;
  exported: boolean;
  enabled: boolean;
  permission: string;
  protectionLevel?: number;
  protectionLabel?: string;
  signatureGated?: boolean;
};

export type PrinterServiceEnumResult = {
  queryAllPackagesGranted: boolean;
  targetSdk: number;
  sdkInt: number;
  model: string;
  packagesScanned: number;
  servicesScanned: number;
  matchingServiceCount: number;
  matchingServices: EnumeratedServiceInfo[];
  relatedPackageNames: string[];
  allServiceCount?: number;
  allServices?: EnumeratedServiceInfo[];
  focusServiceCount?: number;
  focusPackageServices?: EnumeratedServiceInfo[];
  focusPackageStatus?: Array<{
    packageName: string;
    installed: boolean;
    serviceCount: number;
  }>;
  signatureGatedServiceCount?: number;
  signatureGatedServices?: EnumeratedServiceInfo[];
};

/**
 * Staging diagnostic: PackageManager.queryIntentServices(com.wisepos.aidl.service, 0)
 * — same flags the WisePos SDK uses when binding. Does not print or init the SDK.
 */
export async function probeUsdkAidlService(): Promise<UsdkAidlProbeResult> {
  if (Platform.OS !== 'android' || !WiseSdk6PrinterModule?.probeService) {
    throw new Error('AIDL probe is only available on the Android terminal build');
  }
  const raw = await WiseSdk6PrinterModule.probeService();
  const services =
    raw.services?.map(s => ({
      packageName: s.packageName,
      serviceName: s.serviceName,
    })) ??
    (raw.components ?? []).map(c => {
      const slash = c.indexOf('/');
      return slash >= 0
        ? {packageName: c.slice(0, slash), serviceName: c.slice(slash + 1)}
        : {packageName: c, serviceName: '?'};
    });
  return {
    action: raw.action,
    matchCount: raw.matchCount,
    matchAllCount: raw.matchAllCount ?? 0,
    model: raw.model,
    sdkInt: raw.sdkInt,
    targetSdk: raw.targetSdk ?? 0,
    queryAllPackagesGranted: raw.queryAllPackagesGranted ?? false,
    packageVisibilityApplies: raw.packageVisibilityApplies ?? false,
    summary: raw.summary,
    services,
  };
}

/** Staging forensic: enumerate printer/WisePos-related installed services. */
export async function enumeratePrinterRelatedServices(): Promise<PrinterServiceEnumResult> {
  if (
    Platform.OS !== 'android' ||
    !WiseSdk6PrinterModule?.enumeratePrinterRelatedServices
  ) {
    throw new Error('Service enumeration is only available on the Android terminal build');
  }
  return WiseSdk6PrinterModule.enumeratePrinterRelatedServices();
}

export type RealInitPosSdkResult = {
  outcome: 'SUCCESS' | 'FAIL' | 'TIMEOUT' | 'THREW' | string;
  errorCode?: number;
  errorName?: string;
  failBranch?: string;
  preInitMatchCount?: number;
  summary: string;
  contextClass?: string;
  printerStatusOk?: boolean;
  printerStatusError?: string;
  printerStatusRaw?: string;
  printerStatus?: Record<string, unknown>;
};

/**
 * Staging forensic: call the real WisePosSdk.initPosSdk() (SDKDemo MainActivity path).
 * On success also runs getPrinter().getPrinterStatus().
 */
export async function testRealInitPosSdk(): Promise<RealInitPosSdkResult> {
  if (Platform.OS !== 'android' || !WiseSdk6PrinterModule?.testRealInitPosSdk) {
    throw new Error('Real initPosSdk test is only available on the Android terminal build');
  }
  return WiseSdk6PrinterModule.testRealInitPosSdk();
}
