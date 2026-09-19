/**
 * F19 — THE DEVICE NAMES ITSELF AT ACTIVATION.
 *
 * `app/api/terminals/activate/route.ts` has always read `sn` and `device_id` off the activation
 * body and written them to `restaurant_terminals`. This app never sent either: `activateTerminal`
 * posted `JSON.stringify({code})`.
 *
 * Measured on production, read-only, 2026-09-19: of 274 registrations FOUR carry an `sn` -- all
 * four from a manual seed on 2026-06-17 -- and 270 carry `sn = null` with a `device_serial` of
 * `ft-<the row's own uuid>`, which the activation route synthesises from the row id. So the column
 * identifies the REGISTRATION and says nothing about the reader, and when one physical device has
 * two registrations (WPYB002452000261 does) nothing in the data distinguishes them.
 *
 * WHAT THESE PIN, in order of what would hurt most if it broke:
 *
 *   1. activation still succeeds when there is NO serial -- a till that cannot be set up because a
 *      diagnostic value was unreadable is far worse than a registration without one
 *   2. the serial is SENT when there is one, under the key the server already reads
 *   3. ANDROID_ID is never written into `sn`
 */
import {NativeModules} from 'react-native';

jest.mock('../../constants', () => ({
  APP_VERSION: '2.38',
  FLASHTAP_API_URL: 'https://example.test',
  TOKEN_STORAGE_KEY: 'k',
  REFRESH_TOKEN_STORAGE_KEY: 'rk',
  RESTAURANT_ID_STORAGE_KEY: 'ri',
  TERMINAL_ID_STORAGE_KEY: 'ti',
  RESTAURANT_NAME_STORAGE_KEY: 'rn',
}));

describe('getDeviceIdentity', () => {
  const original = NativeModules.DeviceIdentity;

  afterEach(() => {
    (NativeModules as Record<string, unknown>).DeviceIdentity = original;
    jest.resetModules();
  });

  it('returns the serial the native module reports', async () => {
    (NativeModules as Record<string, unknown>).DeviceIdentity = {
      getIdentity: jest.fn(async () => ({
        serial: 'WPYB002452000261',
        serialSource: 'wisepos_sdk',
        androidId: 'aa8168fab9b87b2d',
        model: 'P5',
        manufacturer: 'WISE',
        reason: null,
      })),
    };
    const {getDeviceIdentity} = require('../deviceIdentity');

    await expect(getDeviceIdentity()).resolves.toEqual({
      serial: 'WPYB002452000261',
      serialSource: 'wisepos_sdk',
      androidId: 'aa8168fab9b87b2d',
      model: 'P5',
      manufacturer: 'WISE',
      reason: null,
    });
  });

  it('resolves to a null serial when the native module is absent', async () => {
    // An older shell, a JS-only test run, a station build. Not an error.
    delete (NativeModules as Record<string, unknown>).DeviceIdentity;
    const {getDeviceIdentity} = require('../deviceIdentity');

    const identity = await getDeviceIdentity();
    expect(identity.serial).toBeNull();
    expect(identity.reason).toBe('native_module_unavailable');
  });

  it('resolves to a null serial when the native module throws', async () => {
    (NativeModules as Record<string, unknown>).DeviceIdentity = {
      getIdentity: jest.fn(async () => {
        throw new Error('sdk not bound');
      }),
    };
    const {getDeviceIdentity} = require('../deviceIdentity');

    const identity = await getDeviceIdentity();
    expect(identity.serial).toBeNull();
    expect(identity.reason).toMatch(/native_threw:.*sdk not bound/);
  });

  it('NEVER substitutes androidId for a missing serial', async () => {
    /**
     * The one thing that would silently make this feature worse than useless. ANDROID_ID is
     * per-app-install and resets on a factory wipe, so writing it into a column called `sn` puts a
     * value that is not a serial where every reader expects one -- and it would look populated.
     */
    (NativeModules as Record<string, unknown>).DeviceIdentity = {
      getIdentity: jest.fn(async () => ({
        serial: null,
        serialSource: null,
        androidId: 'aa8168fab9b87b2d',
        model: 'Generic Tablet',
        manufacturer: 'Acme',
        reason: 'wisepos_device_unavailable',
      })),
    };
    const {getDeviceIdentity} = require('../deviceIdentity');

    const identity = await getDeviceIdentity();
    expect(identity.serial).toBeNull();
    expect(identity.androidId).toBe('aa8168fab9b87b2d');
  });
});

describe('activateTerminal sends what the device knows', () => {
  const originalFetch = globalThis.fetch;

  function stubFetch() {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        restaurant_id: 'rest-1',
        terminal_id: 'term-1',
      }),
    }));
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    return fetchMock;
  }

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mockStorage() {
    jest.doMock('../storage', () => ({
      saveTerminalToken: jest.fn(async () => undefined),
      saveRefreshToken: jest.fn(async () => undefined),
      saveRestaurantId: jest.fn(async () => undefined),
      saveTerminalId: jest.fn(async () => undefined),
      saveRestaurantName: jest.fn(async () => undefined),
      saveMerchantCredentials: jest.fn(async () => undefined),
      getTerminalToken: jest.fn(async () => 'a'),
      getRefreshToken: jest.fn(async () => 'r'),
    }))
  }

  it('sends sn and device_id when the reader supplies them', async () => {
    jest.doMock('../deviceIdentity', () => ({
      getDeviceIdentity: jest.fn(async () => ({
        serial: 'WPYB002452000261',
        serialSource: 'wisepos_sdk',
        androidId: 'aa8168fab9b87b2d',
        model: 'P5',
        manufacturer: 'WISE',
        reason: null,
      })),
    }));
    mockStorage();
    const fetchMock = stubFetch();

    const {activateTerminal} = require('../api');
    await activateTerminal('123456');

    const init = (fetchMock.mock.calls[0] as unknown as [string, {body: string}])[1]
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toEqual({
      code: '123456',
      sn: 'WPYB002452000261',
      device_id: 'aa8168fab9b87b2d',
    });
  });

  it('ACTIVATES ANYWAY when there is no serial, omitting the key rather than sending null', async () => {
    /**
     * The behaviour that must not regress. The server guards with `if (terminalSn)`, so an
     * explicit null would also be ignored -- but an absent key is the honest shape for "this
     * device did not say", and a station tablet must still be able to activate.
     */
    jest.doMock('../deviceIdentity', () => ({
      getDeviceIdentity: jest.fn(async () => ({
        serial: null,
        serialSource: null,
        androidId: null,
        model: null,
        manufacturer: null,
        reason: 'wisepos_device_unavailable',
      })),
    }));
    mockStorage();
    const fetchMock = stubFetch();

    const {activateTerminal} = require('../api');
    await expect(activateTerminal('123456')).resolves.toBeTruthy();

    const init = (fetchMock.mock.calls[0] as unknown as [string, {body: string}])[1]
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toEqual({code: '123456'});
    expect('sn' in body).toBe(false);
    expect('device_id' in body).toBe(false);
  });
});
