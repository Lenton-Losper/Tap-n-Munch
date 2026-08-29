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
  restaurantLinesChannelName,
  LINE_CHANGED_EVENT,
  MIN_INVALIDATE_INTERVAL_MS,
} from '../realtimeInvalidation';

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
  mockRemoveChannelCalls.length = 0;
  mockAppStateListener = null;
  mockAppStateRemove.mockClear();
  (AppState.addEventListener as jest.Mock).mockClear();
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
