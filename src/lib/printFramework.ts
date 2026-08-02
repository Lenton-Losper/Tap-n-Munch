import {NativeModules, Platform} from 'react-native';

const {PrintFrameworkModule} = NativeModules as {
  PrintFrameworkModule?: {
    listPrintServices: () => Promise<PrintServicesProbeResult>;
    printSystemTestReceipt: () => Promise<SystemPrintTestResult>;
  };
};

export type PrintServiceInfoRow = {
  packageName: string;
  className: string;
  name: string;
  isEnabled: boolean;
  isBips: boolean;
};

export type PrintServicesProbeResult = {
  sdkInt: number;
  model: string;
  manufacturer: string;
  enabledServices: PrintServiceInfoRow[];
  allServices: PrintServiceInfoRow[];
  enabledCount: number;
  allCount: number;
  bipsEnabled: boolean;
  bipsPresentInAll: boolean;
  silentPrintSupportedByFramework: string;
  summary: string;
};

export type SystemPrintTestResult = {
  outcome: string;
  jobId: string;
  jobName: string;
  jobState: number;
  systemPrintUiRequired: boolean;
  note: string;
  timestamp: string;
};

export async function listSystemPrintServices(): Promise<PrintServicesProbeResult> {
  if (Platform.OS !== 'android' || !PrintFrameworkModule?.listPrintServices) {
    throw new Error('PrintFrameworkModule.listPrintServices unavailable');
  }
  return PrintFrameworkModule.listPrintServices();
}

export async function printSystemTestReceipt(): Promise<SystemPrintTestResult> {
  if (Platform.OS !== 'android' || !PrintFrameworkModule?.printSystemTestReceipt) {
    throw new Error('PrintFrameworkModule.printSystemTestReceipt unavailable');
  }
  return PrintFrameworkModule.printSystemTestReceipt();
}
