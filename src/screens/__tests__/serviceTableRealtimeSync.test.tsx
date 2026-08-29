/**
 * The actual reported bug, reproduced and then fixed: "Bar presses Out, the terminal keeps
 * showing Being made." Confirmed server-side that GET /api/terminal/tabs/{tabId}/lines' is_ready
 * is correct the instant it is asked — the gap was entirely "nothing tells this screen to ask
 * again." This proves the fix at the one level that matters: the chip updates because an
 * invalidation arrived, not because a timer eventually fired.
 */
jest.setTimeout(30000);

import React from 'react';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';
import type {TabLinesPayload} from '../../lib/tabLines';
import type {TableWithTab} from '../../types';

const mockGetTabLines = jest.fn();
const mockGetTablesWithMeta = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTabLines: (...args: unknown[]) => mockGetTabLines(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) => mockGetTablesWithMeta(...(args as [])),
  };
});

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'terminal-token'),
  getRestaurantId: jest.fn(async () => 'restaurant-1'),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const React_ = jest.requireActual('react');
    React_.useEffect(cb, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

jest.mock('../../context/ServiceSessionContext', () => ({
  useServiceSession: () => ({table: null}),
}));

// The one thing this file actually exercises: capture the onInvalidate callback the screen wires
// up, so a test can fire it directly -- exactly what a real broadcast arriving does -- without
// needing a live socket or a fake timer standing in for the 45s safety-net poll.
let capturedOnInvalidate: (() => void) | null = null;
const mockUnsubscribe = jest.fn();
jest.mock('../../lib/realtimeInvalidation', () => ({
  // resolveRestaurantId, not getRestaurantId, is what the screen calls now -- see its own
  // docblock. A fixed non-null value is enough here: this file's tests aren't about resolution
  // itself, only about what happens once a subscription (real or captured) exists.
  resolveRestaurantId: jest.fn(async () => 'restaurant-1'),
  subscribeLineChangeInvalidation: (
    _restaurantId: string | null,
    onInvalidate: () => void,
  ) => {
    capturedOnInvalidate = onInvalidate;
    return mockUnsubscribe;
  },
}));

import ServiceTableScreen from '../ServiceTableScreen';

function payloadWithLineState(isReady: boolean): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 2,
      status: 'open',
      total: 0,
      opened_at: '2026-08-29T05:49:00Z',
      opened_by_user_id: 'waiter-1',
    },
    orders: [
      {
        order_id: 'order-35',
        order_number: 35,
        order_instructions: null,
        order_total: 9,
        placed_at: '2026-08-29T05:49:00Z',
        seconds_since_placed: 60,
        lines: [
          {
            id: 'line-cappuccino',
            name_snapshot: 'Cappuccino',
            quantity: 1,
            line_note: null,
            route_to: 'bar',
            kitchen_state: null,
            bar_state: isReady ? 'ready' : 'cooked',
            is_ready: isReady,
            is_voided: false,
            unrouted: false,
          },
        ],
      },
    ],
    summary: {total_lines: 1, outstanding: isReady ? 0 : 1, ready: isReady ? 1 : 0, voided: 0},
    all_ready: isReady,
    has_lines: true,
    server_time: null,
  };
}

function tableMoneyFixture(): TableWithTab {
  return {
    id: 'table-2',
    table_number: 2,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: 0,
      unpaid_total: 0,
      orders: [],
    },
  };
}

function chipTextFor(root: ReactTestInstance, itemName: string): string | null {
  // Walk every Text node, find the one holding the item name, then read the state chip that sits
  // in the same row -- mirrors how ServiceTableScreen actually renders LineRow (name and chip as
  // sibling Text children of one row View), without depending on a testID this screen doesn't set.
  const {Text} = require('react-native');
  const allText = root.findAllByType(Text).map(t => {
    const collect = (children: unknown): string => {
      if (typeof children === 'string') return children;
      if (Array.isArray(children)) return children.map(collect).join('');
      return '';
    };
    return collect(t.props.children);
  });
  const nameIndex = allText.findIndex(t => t.includes(itemName));
  if (nameIndex === -1) return null;
  // The chip is the very next Text node after the line name in render order.
  return allText[nameIndex + 1] ?? null;
}

describe('ServiceTableScreen — realtime invalidation actually updates the chip', () => {
  let navigation: {navigate: jest.Mock; goBack: jest.Mock};

  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnInvalidate = null;
    mockGetTablesWithMeta.mockResolvedValue({
      tables: [tableMoneyFixture()],
      cardInFlightTimeoutSeconds: 120,
    });
    navigation = {navigate: jest.fn(), goBack: jest.fn()};
  });

  it('reproduces the gap, then closes it: the chip only moves once an invalidation actually arrives', async () => {
    mockGetTabLines.mockResolvedValueOnce(payloadWithLineState(false));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ServiceTableScreen
          route={
            {
              params: {
                tableId: 'table-2',
                tableNumber: 2,
                tableName: null,
                tabId: 'tab-1',
                ownerName: 'lenton',
                ownerUserId: 'waiter-1',
              },
              key: 'k',
              name: 'ServiceTable',
            } as never
          }
          navigation={navigation as never}
        />,
      );
    });

    expect(chipTextFor(tree.root, 'Cappuccino')).toBe('Being made');
    expect(capturedOnInvalidate).not.toBeNull();

    // THE GAP, reproduced: the bar has pressed Out server-side (the mock now returns ready), but
    // nothing has told this screen yet. Without an invalidation, it must still read stale --
    // proving there is a real gap to close, not asserting a tautology.
    mockGetTabLines.mockResolvedValueOnce(payloadWithLineState(true));
    expect(chipTextFor(tree.root, 'Cappuccino')).toBe('Being made');
    expect(mockGetTabLines).toHaveBeenCalledTimes(1);

    // THE FIX: fire the SAME callback subscribeLineChangeInvalidation would call the instant the
    // server's broadcast lands. No timer advanced, no navigation away and back.
    await act(async () => {
      capturedOnInvalidate?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetTabLines).toHaveBeenCalledTimes(2);
    expect(chipTextFor(tree.root, 'Cappuccino')).toBe('Ready');

    act(() => tree.unmount());
  });

  it('unsubscribes on unmount', async () => {
    mockGetTabLines.mockResolvedValue(payloadWithLineState(false));

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ServiceTableScreen
          route={
            {
              params: {
                tableId: 'table-2',
                tableNumber: 2,
                tableName: null,
                tabId: 'tab-1',
                ownerName: null,
                ownerUserId: null,
              },
              key: 'k',
              name: 'ServiceTable',
            } as never
          }
          navigation={navigation as never}
        />,
      );
    });

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    act(() => tree.unmount());
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
