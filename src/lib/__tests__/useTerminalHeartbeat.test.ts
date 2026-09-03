/**
 * #373 — a terminal must always report what it is running.
 *
 * The heartbeat used to live in an effect inside OrdersScreen, so it only ran while that screen was
 * mounted, and only on the interval. A till parked on Tables or Settings — most of a shift — never
 * sent its version, and a freshly activated one reported nothing for five minutes.
 *
 * That cost a long investigation on 2026-09-02: a "collected reverts to Being made" report whose
 * real cause was a till on a build older than the commit that taught the terminal the word
 * `collected`. `app_version` was null, so the one field that answers "what is this device running?"
 * answered nothing.
 *
 * The assertions that matter are the two that were previously false: it fires ON MOUNT, and it
 * fires when the app returns to the FOREGROUND.
 */

const mockGetTerminalToken = jest.fn();
jest.mock('../storage', () => ({
  getTerminalToken: (...a: unknown[]) => mockGetTerminalToken(...a),
}));

const mockSendHeartbeat = jest.fn();
jest.mock('../api', () => ({
  sendHeartbeat: (...a: unknown[]) => mockSendHeartbeat(...a),
}));

jest.mock('../../constants', () => ({APP_VERSION: '2.18'}));

let appStateListener: ((s: string) => void) | null = null;
const mockRemove = jest.fn();
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_e: string, l: (s: string) => void) => {
      appStateListener = l;
      return {remove: mockRemove};
    }),
  },
}));

import {startTerminalHeartbeat, HEARTBEAT_INTERVAL_MS} from '../useTerminalHeartbeat';

// Microtasks, not setImmediate: jest's fake timers fake setImmediate too, so a timer-based
// flush never settles and every test times out at 5 s instead of failing on an assertion.
const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); } };

beforeEach(() => {
  jest.useFakeTimers();
  mockGetTerminalToken.mockReset().mockResolvedValue('tok');
  mockSendHeartbeat.mockReset().mockResolvedValue(undefined);
  appStateListener = null;
  mockRemove.mockClear();
});
afterEach(() => jest.useRealTimers());

describe('useTerminalHeartbeat', () => {
  it('reports the version immediately on mount, not after the first interval', async () => {
    startTerminalHeartbeat();
    await flush();
    expect(mockSendHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockSendHeartbeat).toHaveBeenCalledWith('tok', '2.18');
  });

  it('keeps reporting on the interval', async () => {
    startTerminalHeartbeat();
    await flush();
    mockSendHeartbeat.mockClear();

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(mockSendHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('reports again when the app returns to the foreground', async () => {
    // A till asleep in a drawer overnight comes back with yesterday's version on the record.
    startTerminalHeartbeat();
    await flush();
    mockSendHeartbeat.mockClear();

    appStateListener?.('active');
    await flush();
    expect(mockSendHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('does not report on a background transition', async () => {
    startTerminalHeartbeat();
    await flush();
    mockSendHeartbeat.mockClear();

    appStateListener?.('background');
    await flush();
    expect(mockSendHeartbeat).not.toHaveBeenCalled();
  });

  it('sends nothing when the terminal has no token', async () => {
    // An unactivated terminal has nothing to report and no credential to report it with.
    mockGetTerminalToken.mockResolvedValue(null);
    startTerminalHeartbeat();
    await flush();
    expect(mockSendHeartbeat).not.toHaveBeenCalled();
  });

  it('never lets a failed heartbeat surface — it is diagnostics, not service', async () => {
    mockSendHeartbeat.mockRejectedValue(new Error('network down'));
    expect(() => startTerminalHeartbeat()).not.toThrow();
    await flush();
  });

  it('releases the interval and the AppState listener on unmount', () => {
    const stop = startTerminalHeartbeat();
    stop();
    expect(mockRemove).toHaveBeenCalled();
  });
});
