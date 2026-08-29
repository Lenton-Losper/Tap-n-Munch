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
import {subscribeLineChangeInvalidation, restaurantLinesChannelName, LINE_CHANGED_EVENT} from '../realtimeInvalidation';

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

describe('subscribeLineChangeInvalidation — teardown', () => {
  it('removes the channel and the AppState listener', () => {
    const teardown = subscribeLineChangeInvalidation('rest-1', jest.fn());
    teardown();

    expect(mockRemoveChannelCalls).toEqual([mockChannel]);
    expect(mockAppStateRemove).toHaveBeenCalledTimes(1);
  });
});
