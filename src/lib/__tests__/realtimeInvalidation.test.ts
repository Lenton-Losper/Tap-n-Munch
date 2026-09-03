/**
 * src/lib/realtimeInvalidation.ts — proves the three cases the module docblock names for when
 * `onInvalidate` fires (broadcast, reconnect, foreground), the two it names for when it must NOT
 * (first join, no restaurantId yet), and that teardown actually releases both the channel and the
 * AppState listener.
 *
 * REPRODUCES THE GAP FIRST (the "must NOT fire" cases below) before proving the fix (the "DOES
 * fire" cases): a module that invalidated on every status callback, or on the very first
 * SUBSCRIBED, would look like it worked in a demo and then double-fetch or over-fire in the field
 * — the same class of defect as the PowerShell/gradle-exit lessons already in this repo's own
 * handover docs about trusting the wrong signal.
 */
import {AppState} from 'react-native';
import {
  subscribeLineChangeInvalidation,
  resolveRestaurantId,
  getRealtimeDiagnostics,
  subscribeRealtimeDiagnostics,
  resetRealtimeDiagnosticsForTest,
  restaurantLinesChannelName,
  restaurantLinesPrivateChannelName,
  LINE_CHANGED_EVENT,
  MIN_INVALIDATE_INTERVAL_MS,
} from '../realtimeInvalidation';

const mockGetRestaurantId = jest.fn();
const mockSaveRestaurantId = jest.fn();
const mockGetTerminalToken = jest.fn();
jest.mock('../storage', () => ({
  getRestaurantId: (...args: unknown[]) => mockGetRestaurantId(...args),
  saveRestaurantId: (...args: unknown[]) => mockSaveRestaurantId(...args),
  getTerminalToken: (...args: unknown[]) => mockGetTerminalToken(...args),
}));

const mockGetTerminalInfo = jest.fn();
jest.mock('../api', () => ({
  getTerminalInfo: (...args: unknown[]) => mockGetTerminalInfo(...args),
}));

type BroadcastHandler = (payload: unknown) => void;
type StatusHandler = (status: string) => void;

function makeFakeChannel() {
  let broadcastHandler: BroadcastHandler | null = null;
  let statusHandler: StatusHandler | null = null;
  const fake = {
    on(type: string, filter: {event: string}, handler: BroadcastHandler) {
      if (type === 'broadcast' && filter.event === LINE_CHANGED_EVENT) {
        broadcastHandler = handler;
      }
      return fake;
    },
    subscribe(cb: StatusHandler) {
      statusHandler = cb;
      return fake;
    },
    fireBroadcast() {
      broadcastHandler?.({});
    },
    fireStatus(status: string) {
      statusHandler?.(status);
    },
  };
  return fake;
}

let mockChannel: ReturnType<typeof makeFakeChannel>;
const mockChannelCalls: string[] = [];
const mockRemoveChannelCalls: unknown[] = [];

let mockPrivateChannel: ReturnType<typeof makeFakeChannel>;
const mockPrivateChannelCalls: Array<{name: string; config: unknown}> = [];
const mockPrivateSetAuth = jest.fn();
const mockPrivateDisconnect = jest.fn();
const mockPrivateRemoveChannel = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    channel: (name: string) => {
      mockChannelCalls.push(name);
      return mockChannel;
    },
    removeChannel: (ch: unknown) => {
      mockRemoveChannelCalls.push(ch);
    },
  },
  // WITHOUT THIS the private probe throws on every call and the failure is invisible: it runs
  // inside a floating promise, so an unhandled rejection is all that happens and every test in
  // this file still passes. That is the shape of bug this whole change is about.
  createPrivateChannelClient: () => ({
    realtime: {setAuth: mockPrivateSetAuth, disconnect: mockPrivateDisconnect},
    channel: (name: string, config: unknown) => {
      mockPrivateChannelCalls.push({name, config});
      return mockPrivateChannel;
    },
    removeChannel: mockPrivateRemoveChannel,
  }),
}));

let mockAppStateListener: ((state: string) => void) | null = null;
const mockAppStateRemove = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
      mockAppStateListener = listener;
      return {remove: mockAppStateRemove};
    }),
  },
}));

beforeEach(() => {
  mockChannel = makeFakeChannel();
  mockChannelCalls.length = 0;
  mockPrivateChannel = makeFakeChannel();
  mockPrivateChannelCalls.length = 0;
  mockPrivateSetAuth.mockClear();
  mockPrivateDisconnect.mockClear();
  mockPrivateRemoveChannel.mockClear();
  mockRemoveChannelCalls.length = 0;
  mockAppStateListener = null;
  mockAppStateRemove.mockClear();
  (AppState.addEventListener as jest.Mock).mockClear();
  mockGetRestaurantId.mockReset();
  mockSaveRestaurantId.mockReset();
  mockGetTerminalToken.mockReset();
  mockGetTerminalInfo.mockReset();
  resetRealtimeDiagnosticsForTest();
});

describe('subscribeLineChangeInvalidation — null restaurantId', () => {
  it('is a no-op: never touches the channel, and its teardown is safe to call', () => {
    const onInvalidate = jest.fn();
    const teardown = subscribeLineChangeInvalidation(null, onInvalidate);

    expect(mockChannelCalls).toHaveLength(0);
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(() => teardown()).not.toThrow();
  });
});

describe('subscribeLineChangeInvalidation — the DOES-fire cases', () => {
  it('subscribes on the restaurant-scoped channel name', () => {
    subscribeLineChangeInvalidation('rest-1', jest.fn());
    expect(mockChannelCalls).toEqual([restaurantLinesChannelName('rest-1')]);
  });

  it('fires onInvalidate when a line_changed broadcast arrives', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED'); // first join — must not itself count as a fire
    onInvalidate.mockClear();

    mockChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('fires onInvalidate on a RECONNECT — SUBSCRIBED again after having gone down', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);

    mockChannel.fireStatus('SUBSCRIBED'); // first join
    expect(onInvalidate).not.toHaveBeenCalled();

    mockChannel.fireStatus('CHANNEL_ERROR'); // drop
    mockChannel.fireStatus('SUBSCRIBED'); // RETURN — a broadcast could have been missed in between
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('fires onInvalidate when the app returns to the foreground', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);

    mockAppStateListener?.('background');
    expect(onInvalidate).not.toHaveBeenCalled();

    mockAppStateListener?.('active');
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeLineChangeInvalidation — the must-NOT-fire cases', () => {
  it('does NOT fire on the very first SUBSCRIBED (the caller already fetched on mount)', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED');
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('does NOT fire while merely joining or on a drop itself (only on the RETURN to up)', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED');
    onInvalidate.mockClear();

    mockChannel.fireStatus('TIMED_OUT');
    mockChannel.fireStatus('CLOSED');
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});

describe('subscribeLineChangeInvalidation — the debounce (spam/amplification defense)', () => {
  // The security finding this exists for: the channel is public (private: false — RLS cannot
  // apply to this app's identity) and the restaurant id in its name is not a secret (it is
  // already in that restaurant's own public menu QR URL), so anyone holding the anon key can
  // publish fake line_changed messages on a real restaurant's channel as fast as they like. A
  // burst like that must not turn into a burst of GET /api/terminal/tabs/{tabId}/lines calls.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('collapses a burst of broadcasts into one call, not one per message', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED'); // first join
    onInvalidate.mockClear();

    for (let i = 0; i < 50; i++) {
      mockChannel.fireBroadcast();
    }
    // The FIRST call in a fresh window fires immediately (real bumps must still feel instant) --
    // the other 49 in the same burst must not each cost a refetch.
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('still delivers the LAST invalidation in a burst, trailing-edge, not just the first', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED');
    onInvalidate.mockClear();

    mockChannel.fireBroadcast(); // fires immediately (call #1)
    mockChannel.fireBroadcast(); // suppressed, schedules a trailing call
    mockChannel.fireBroadcast(); // already scheduled -- this one changes nothing new

    jest.advanceTimersByTime(MIN_INVALIDATE_INTERVAL_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(2); // the immediate one, then the trailing one
  });

  it('a real bump well after the window is never suppressed by an unrelated attack burst', () => {
    const onInvalidate = jest.fn();
    subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED');
    onInvalidate.mockClear();

    mockChannel.fireBroadcast(); // the "attack" -- fires immediately, starts the window
    jest.advanceTimersByTime(MIN_INVALIDATE_INTERVAL_MS + 100); // window fully elapsed

    mockChannel.fireBroadcast(); // a genuine bump, well clear of the window
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending trailing call on teardown so it cannot fire after unmount', () => {
    const onInvalidate = jest.fn();
    const teardown = subscribeLineChangeInvalidation('rest-1', onInvalidate);
    mockChannel.fireStatus('SUBSCRIBED');
    onInvalidate.mockClear();

    mockChannel.fireBroadcast(); // immediate
    mockChannel.fireBroadcast(); // schedules a trailing call
    teardown();

    jest.advanceTimersByTime(MIN_INVALIDATE_INTERVAL_MS + 100);
    expect(onInvalidate).toHaveBeenCalledTimes(1); // only the immediate one -- trailing was cancelled
  });
});

describe('subscribeLineChangeInvalidation — teardown', () => {
  it('removes the channel and the AppState listener', () => {
    const teardown = subscribeLineChangeInvalidation('rest-1', jest.fn());
    teardown();

    expect(mockRemoveChannelCalls).toEqual([mockChannel]);
    expect(mockAppStateRemove).toHaveBeenCalledTimes(1);
  });
});

/**
 * resolveRestaurantId — the production-incident recovery. Traced during that investigation:
 * getRestaurantId() reads a value written exactly once, at activation, and
 * subscribeLineChangeInvalidation's null check makes a missed write PERMANENT and SILENT on that
 * device -- the poll keeps working (it does not need restaurantId), so nothing looks broken, and
 * Realtime just never activates, forever, with no error anywhere. These prove storage is tried
 * first (free), GET /api/terminal/me is the fallback (not a bespoke new endpoint), a successful
 * recovery is written back so the NEXT call does not need the network again, and -- the specific
 * "no longer PERMANENTLY disabled" claim -- that a device with no token at all still resolves to
 * null without throwing, and a device whose token exists but whose recovery fails this time tries
 * again cleanly on the next call rather than caching the failure.
 */
describe('resolveRestaurantId', () => {
  it('returns the stored value without ever calling the recovery API', async () => {
    mockGetRestaurantId.mockResolvedValue('stored-rest-1');

    const result = await resolveRestaurantId();

    expect(result).toBe('stored-rest-1');
    expect(mockGetTerminalToken).not.toHaveBeenCalled();
    expect(mockGetTerminalInfo).not.toHaveBeenCalled();
    expect(mockSaveRestaurantId).not.toHaveBeenCalled();
  });

  it('recovers from GET /api/terminal/me when storage is empty, and persists it', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue('a-real-terminal-token');
    mockGetTerminalInfo.mockResolvedValue({restaurant_id: 'recovered-rest-1'});

    const result = await resolveRestaurantId();

    expect(result).toBe('recovered-rest-1');
    expect(mockGetTerminalInfo).toHaveBeenCalledWith('a-real-terminal-token');
    expect(mockSaveRestaurantId).toHaveBeenCalledWith('recovered-rest-1');
  });

  it('accepts the camelCase restaurantId field too, not only restaurant_id', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue('token');
    mockGetTerminalInfo.mockResolvedValue({restaurantId: 'camel-rest-1'});

    expect(await resolveRestaurantId()).toBe('camel-rest-1');
    expect(mockSaveRestaurantId).toHaveBeenCalledWith('camel-rest-1');
  });

  it('a device with no terminal token at all resolves to null without touching the network', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue(null);

    const result = await resolveRestaurantId();

    expect(result).toBeNull();
    expect(mockGetTerminalInfo).not.toHaveBeenCalled();
    expect(mockSaveRestaurantId).not.toHaveBeenCalled();
  });

  it('a recovery API failure resolves to null this call, but does NOT cache the failure permanently', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue('token');
    mockGetTerminalInfo.mockRejectedValueOnce(new Error('network down'));

    const firstAttempt = await resolveRestaurantId();
    expect(firstAttempt).toBeNull();
    expect(mockSaveRestaurantId).not.toHaveBeenCalled();

    // The network recovers (or storage does, if another code path wrote it meanwhile) by the
    // NEXT call -- e.g. the next screen focus. Nothing in resolveRestaurantId remembers the
    // first failure and short-circuits early.
    mockGetTerminalInfo.mockResolvedValueOnce({restaurant_id: 'recovered-on-retry'});
    const secondAttempt = await resolveRestaurantId();
    expect(secondAttempt).toBe('recovered-on-retry');
  });

  it('a /me response with no restaurant_id at all resolves to null, not undefined or a crash', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue('token');
    mockGetTerminalInfo.mockResolvedValue({});

    expect(await resolveRestaurantId()).toBeNull();
    expect(mockSaveRestaurantId).not.toHaveBeenCalled();
  });
});

/**
 * The end-to-end version of "no longer permanently disabled": storage empty on the first focus,
 * subscribeLineChangeInvalidation never gets to run at all that time (the null no-op path) --
 * but resolving it fresh on a LATER focus, once recovery succeeds, actually starts a real
 * subscription. This is the shape ServiceTableScreen/ServiceFloorScreen's own effect follows
 * (call resolveRestaurantId() -> pass whatever it returns to subscribeLineChangeInvalidation),
 * exercised directly here without needing a full screen render.
 */
describe('resolveRestaurantId + subscribeLineChangeInvalidation — recovery unblocks a real subscription', () => {
  it('first focus: no restaurantId anywhere -> no subscription. Later focus: recovered -> a real channel opens', async () => {
    mockGetRestaurantId.mockResolvedValue(null);
    mockGetTerminalToken.mockResolvedValue(null); // nothing to recover from yet either

    const firstResolved = await resolveRestaurantId();
    const firstTeardown = subscribeLineChangeInvalidation(firstResolved, jest.fn());
    expect(firstResolved).toBeNull();
    expect(mockChannelCalls).toHaveLength(0);
    firstTeardown();

    // The device comes back online / activation catches up; the SAME storage read now succeeds.
    mockGetRestaurantId.mockResolvedValue('rest-now-available');

    const secondResolved = await resolveRestaurantId();
    const secondTeardown = subscribeLineChangeInvalidation(secondResolved, jest.fn());
    expect(secondResolved).toBe('rest-now-available');
    expect(mockChannelCalls).toEqual([restaurantLinesChannelName('rest-now-available')]);
    secondTeardown();
  });
});

/**
 * The diagnostics store — surfaced in DiagnosticsScreen so a physical device's actual Realtime
 * state is visible without needing a debugger attached. Proves the status transitions match what
 * subscribeLineChangeInvalidation actually does, the raw Supabase status string is preserved
 * alongside the coarse category, restaurantId is exposed (not a secret -- see the module
 * docblock), and lastInvalidationAt updates only when a broadcast is actually received.
 */
describe('realtime diagnostics store', () => {
  it('starts idle with no restaurantId when subscribeLineChangeInvalidation is called with null', () => {
    subscribeLineChangeInvalidation(null, jest.fn());
    expect(getRealtimeDiagnostics()).toMatchObject({status: 'idle', restaurantId: null});
  });

  it('goes joining -> subscribed, exposing the resolved restaurantId and the raw status string', () => {
    subscribeLineChangeInvalidation('rest-1', jest.fn());
    expect(getRealtimeDiagnostics()).toMatchObject({status: 'joining', restaurantId: 'rest-1'});

    mockChannel.fireStatus('SUBSCRIBED');
    expect(getRealtimeDiagnostics()).toMatchObject({
      status: 'subscribed',
      restaurantId: 'rest-1',
      lastRawStatus: 'SUBSCRIBED',
    });
  });

  it('reports reconnecting (not joining) when a channel that WAS up goes down', () => {
    subscribeLineChangeInvalidation('rest-1', jest.fn());
    mockChannel.fireStatus('SUBSCRIBED');

    mockChannel.fireStatus('CHANNEL_ERROR');
    expect(getRealtimeDiagnostics()).toMatchObject({
      status: 'reconnecting',
      lastRawStatus: 'CHANNEL_ERROR',
    });
  });

  it('records lastInvalidationAt when a broadcast is actually received, not before', () => {
    subscribeLineChangeInvalidation('rest-1', jest.fn());
    mockChannel.fireStatus('SUBSCRIBED');
    expect(getRealtimeDiagnostics().lastInvalidationAt).toBeNull();

    mockChannel.fireBroadcast();
    expect(getRealtimeDiagnostics().lastInvalidationAt).not.toBeNull();
  });

  it('returns to idle on teardown', () => {
    const teardown = subscribeLineChangeInvalidation('rest-1', jest.fn());
    mockChannel.fireStatus('SUBSCRIBED');
    teardown();
    expect(getRealtimeDiagnostics().status).toBe('idle');
  });

  it('notifies subscribers on every change', () => {
    const listener = jest.fn();
    const unsub = subscribeRealtimeDiagnostics(listener);

    subscribeLineChangeInvalidation('rest-1', jest.fn());
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    mockChannel.fireStatus('SUBSCRIBED');
    expect(listener).toHaveBeenCalled();

    unsub();
    listener.mockClear();
    mockChannel.fireStatus('CHANNEL_ERROR');
    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * ============================================================================================
 * PHASE B — THE PRIVATE CHANNEL PROBE
 * ============================================================================================
 *
 * These exist because the probe's first version was, itself, an instance of the bug this change
 * is about. It runs inside a floating promise, so when the test mock did not export
 * createPrivateChannelClient it threw on every single call, produced nothing but an unhandled
 * rejection, and all 25 tests in this file still passed. It was doing nothing at all and looked
 * fine.
 *
 * So the assertions below are about the probe HAVING RUN — the topic it joined, the flag it
 * joined with, the token it presented — not merely about it not crashing.
 */
describe('the private channel probe (Phase B)', () => {
  const RID = 'rest-1';
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  it('joins the PRIVATE topic, with private: true, presenting the terminal token', async () => {
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();

    expect(mockPrivateChannelCalls).toEqual([
      {name: restaurantLinesPrivateChannelName(RID), config: {config: {private: true}}},
    ]);
    expect(mockPrivateSetAuth).toHaveBeenCalledWith('terminal-jwt');
    stop();
  });

  it('is a DIFFERENT topic from the public one — the two must not be the same channel', () => {
    // Reusing the topic name would put public and private subscribers on one topic with different
    // `private` flags. The private path must not be able to break the path the estate runs on.
    expect(restaurantLinesPrivateChannelName(RID)).not.toBe(restaurantLinesChannelName(RID));
  });

  it('leaves the PUBLIC subscription completely untouched', async () => {
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();

    expect(mockChannelCalls).toEqual([restaurantLinesChannelName(RID)]);
    stop();
  });

  it('does not join at all when the terminal has no token', async () => {
    mockGetTerminalToken.mockResolvedValue(null);
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();

    expect(mockPrivateChannelCalls).toEqual([]);
    expect(mockPrivateSetAuth).not.toHaveBeenCalled();
    stop();
  });

  it('records its status separately, never merging it into the real channel health', async () => {
    // The probe is EXPECTED to be denied until the provider is registered. A terminal whose real
    // feed is healthy must not read as faulty because of it.
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();

    mockChannel.fireStatus('SUBSCRIBED');
    mockPrivateChannel.fireStatus('CHANNEL_ERROR');

    expect(getRealtimeDiagnostics().status).toBe('subscribed');
    expect(getRealtimeDiagnostics().lastRawStatus).toBe('SUBSCRIBED');
    expect(getRealtimeDiagnostics().privateStatus).toBe('CHANNEL_ERROR');
    stop();
  });

  it('records privateLastMessageAt only on a real arrival — SUBSCRIBED alone proves nothing', async () => {
    // A denied Realtime subscription reports SUBSCRIBED and then delivers nothing, forever. The
    // arrival is the only observable that tells the two apart.
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();

    mockPrivateChannel.fireStatus('SUBSCRIBED');
    expect(getRealtimeDiagnostics().privateLastMessageAt).toBeNull();

    mockPrivateChannel.fireBroadcast();
    expect(getRealtimeDiagnostics().privateLastMessageAt).not.toBeNull();
    stop();
  });

  it('a PRIVATE message invalidates IMMEDIATELY — the 45s ceiling does not apply to it', async () => {
    // The ceiling exists because the PUBLIC topic accepts a message from anyone holding the anon
    // key, which ships in every APK. That is not true of the private topic: SELECT is gated by an
    // RLS policy keyed to this terminal's restaurant_id, and there is no INSERT policy at all, so
    // the only publisher is our server's service role. No flood is possible, so no ceiling.
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const onInvalidate = jest.fn();
    const stop = subscribeLineChangeInvalidation(RID, onInvalidate);
    await flush();

    mockChannel.fireStatus('SUBSCRIBED');
    onInvalidate.mockClear();

    mockPrivateChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    // ...and again straight away, with no 45s wait in between.
    mockPrivateChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    stop();
  });

  it('the PUBLIC channel keeps its 45s ceiling — it is still floodable', async () => {
    mockGetTerminalToken.mockResolvedValue(null); // no private probe; isolate the public path
    const onInvalidate = jest.fn();
    const stop = subscribeLineChangeInvalidation(RID, onInvalidate);
    await flush();
    onInvalidate.mockClear();

    mockChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    // A second within the window is coalesced, not fired.
    mockChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('coalesces the public copy of the same change into the private one', async () => {
    // The server dual-publishes, so one state change arrives on BOTH topics. The private one
    // fires instantly and must absorb the public copy rather than leaving a second refetch
    // scheduled behind it.
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const onInvalidate = jest.fn();
    const stop = subscribeLineChangeInvalidation(RID, onInvalidate);
    await flush();
    onInvalidate.mockClear();

    mockPrivateChannel.fireBroadcast();
    mockChannel.fireBroadcast();
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(MIN_INVALIDATE_INTERVAL_MS + 1000);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('releases its own socket on teardown, so a remount cannot leak one', async () => {
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    await flush();
    stop();

    expect(mockPrivateRemoveChannel).toHaveBeenCalled();
    expect(mockPrivateDisconnect).toHaveBeenCalled();
  });

  it('tears down a probe that resolved AFTER its caller already unmounted', async () => {
    // The token lookup is async, so a fast unmount can beat it. Without the privateTornDown
    // guard the socket outlives the teardown and every remount leaks one.
    mockGetTerminalToken.mockResolvedValue('terminal-jwt');
    const stop = subscribeLineChangeInvalidation(RID, jest.fn());
    stop();
    await flush();

    expect(mockPrivateDisconnect).toHaveBeenCalled();
  });

  it('survives a probe that throws — a terminal must never break because of it', async () => {
    mockGetTerminalToken.mockRejectedValue(new Error('storage unavailable'));
    const onInvalidate = jest.fn();

    const stop = subscribeLineChangeInvalidation(RID, onInvalidate);
    await flush();

    // The public channel still works, and the failure is recorded rather than silent.
    expect(mockChannelCalls).toEqual([restaurantLinesChannelName(RID)]);
    expect(getRealtimeDiagnostics().privateStatus).toBe('PROBE_UNAVAILABLE');
    stop();
  });
});
