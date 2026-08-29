/**
 * ServiceFloorScreen now uses the SAME restaurant-scoped invalidation channel as
 * ServiceTableScreen (one reusable mechanism, not an ad-hoc second subscription) instead of
 * relying purely on its 45s safety-net poll. Proves: it subscribes with the resolved
 * restaurantId, an invalidation triggers a real floor refetch without waiting for the poll, and
 * teardown actually unsubscribes.
 */
// Same reasoning as serviceTableSettleControl.test.tsx's own note: this screen's real load() ->
// loadBadges() -> per-table Promise.all chain is several promise-hops deep, and a loaded machine
// can genuinely take longer than Jest's 5s default to get through the first render.
jest.setTimeout(30000);

import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {FloorPayload} from '../../lib/api';

const mockGetFloorTables = jest.fn();
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getFloorTables: (...args: unknown[]) => mockGetFloorTables(...(args as [])),
  };
});

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'terminal-token'),
}));

// Also stable, same reason as mockEndSession above.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactActual = jest.requireActual('react');
    ReactActual.useEffect(cb, [cb]);
  },
  useNavigation: () => ({navigate: mockNavigate}),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

// A STABLE reference, not a fresh jest.fn() per call: useFocusEffect's own useCallback depends
// on endSession, and a new function identity every render would retrigger the whole focus effect
// every render -- load() sets state, state change re-renders, re-render makes a new endSession,
// effect fires again. An infinite loop, and it is exactly the kind Jest's own timeout only reports
// as "exceeded timeout", not as its actual cause.
const mockEndSession = jest.fn();
jest.mock('../../context/ServiceSessionContext', () => ({
  useServiceSession: () => ({endSession: mockEndSession}),
}));

let capturedOnInvalidate: (() => void) | null = null;
let capturedRestaurantId: string | null | undefined;
const mockUnsubscribe = jest.fn();
jest.mock('../../lib/realtimeInvalidation', () => ({
  // resolveRestaurantId, not getRestaurantId, is what the screen calls now -- the value it
  // resolves to is exactly what this file's first test asserts against.
  resolveRestaurantId: jest.fn(async () => 'restaurant-1'),
  subscribeLineChangeInvalidation: (restaurantId: string | null, onInvalidate: () => void) => {
    capturedRestaurantId = restaurantId;
    capturedOnInvalidate = onInvalidate;
    return mockUnsubscribe;
  },
}));

import ServiceFloorScreen from '../ServiceFloorScreen';

function floorPayload(openCount: number): FloorPayload {
  return {
    tables: [
      {
        id: 'table-1',
        table_number: 1,
        table_name: null,
        state: openCount > 0 ? 'open' : 'free',
        owner: openCount > 0 ? {user_id: 'w1', name: 'Ana', assigned_at: null} : null,
        opened_at: openCount > 0 ? '2026-08-29T05:00:00Z' : null,
        seconds_open: openCount > 0 ? 120 : null,
        tab: openCount > 0 ? {id: 'tab-1', status: 'open', total: 0} : null,
      },
    ],
    serverTime: null,
  };
}

describe('ServiceFloorScreen — realtime invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnInvalidate = null;
    capturedRestaurantId = undefined;
  });

  it('subscribes with the resolved restaurantId and unsubscribes on unmount', async () => {
    mockGetFloorTables.mockResolvedValue(floorPayload(0));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ServiceFloorScreen />);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(capturedRestaurantId).toBe('restaurant-1');
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    act(() => tree.unmount());
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('an invalidation refetches the floor grid, in poll mode, without waiting for the safety-net timer', async () => {
    mockGetFloorTables.mockResolvedValueOnce(floorPayload(0));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ServiceFloorScreen />);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockGetFloorTables).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({children: 'FREE'}).length).toBeGreaterThan(0);

    mockGetFloorTables.mockResolvedValueOnce(floorPayload(1));

    await act(async () => {
      capturedOnInvalidate?.();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockGetFloorTables).toHaveBeenCalledTimes(2);
    expect(tree.root.findAllByProps({children: 'OPEN'}).length).toBeGreaterThan(0);

    act(() => tree.unmount());
  });
});
