import {NativeModules} from 'react-native';

/**
 * WHAT THIS DEVICE CAN HONESTLY SAY ABOUT ITSELF (F19).
 *
 * ==================================================================================================
 * WHY IT EXISTS
 * ==================================================================================================
 *
 * `restaurant_terminals.sn` has existed since the table was created and
 * `app/api/terminals/activate/route.ts` has always written it from the activation body. Nothing
 * ever sent one -- `activateTerminal` posted `{code}` alone -- so on production, measured
 * read-only on 2026-09-19, 270 of 274 registrations carry `sn = null` and a `device_serial` of
 * `ft-<the row's own uuid>`: an identifier for the ROW, not the device.
 *
 * So a payment resolves to a terminal_id and a terminal_id resolves to nothing physical. When one
 * reader has two registrations -- WPYB002452000261 does -- nothing in the data says which is which.
 *
 * ==================================================================================================
 * NULL IS AN ANSWER
 * ==================================================================================================
 *
 * Every failure resolves to `serial: null` with a `reason`, and activation proceeds without one
 * exactly as it does today. A till that cannot activate because a diagnostic value was unreadable
 * would be a far worse outcome than a registration with no serial on it.
 *
 * `androidId` is returned ALONGSIDE the serial and never instead of it. It is per-app-install and
 * resets on a factory wipe, so putting it in a column called `sn` would place a value that is not
 * a serial where every reader expects one.
 */
export type DeviceIdentity = {
  /** The reader's own serial, from the WisePOS SDK. Null when it could not be obtained. */
  serial: string | null;
  /** 'wisepos_sdk', or null when there is no serial. */
  serialSource: string | null;
  /** Per-app-install Android identifier. NOT a serial; never substituted for one. */
  androidId: string | null;
  model: string | null;
  manufacturer: string | null;
  /** Why there is no serial, when there is none. */
  reason: string | null;
};

const ABSENT: DeviceIdentity = {
  serial: null,
  serialSource: null,
  androidId: null,
  model: null,
  manufacturer: null,
  reason: 'native_module_unavailable',
};

/**
 * Never throws and never rejects.
 *
 * The native module resolves rather than rejecting, but the module itself can be absent -- an
 * older shell, a JS-only test run, a station build. Treating that as an ordinary "no identity"
 * keeps every caller free of a try/catch it would eventually forget.
 */
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const native = NativeModules?.DeviceIdentity;
  if (!native?.getIdentity) {
    return ABSENT;
  }
  try {
    const result = (await native.getIdentity()) as Partial<DeviceIdentity> | null;
    if (!result) {
      return {...ABSENT, reason: 'native_returned_nothing'};
    }
    return {
      serial: result.serial ?? null,
      serialSource: result.serialSource ?? null,
      androidId: result.androidId ?? null,
      model: result.model ?? null,
      manufacturer: result.manufacturer ?? null,
      reason: result.reason ?? null,
    };
  } catch (error) {
    console.warn('[deviceIdentity] could not read the device identity', error);
    return {
      ...ABSENT,
      reason: `native_threw:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
