/**
 * ROUND-LEVEL SPLIT — paying for part of a tab and leaving the rest open.
 *
 * THE GRANULARITY IS A ROUND, NOT A DISH, and that is a property of the server, not a shortcut
 * taken here. POST /api/terminal/tabs/{tabId}/settle takes `order_ids` and computes
 * `expectedAmount` as the sum of THOSE ORDERS' totals, then refuses anything else with
 * 400 AMOUNT_MISMATCH. So a bill splits by order; there is no request shape that pays for two
 * of the four dishes on one order, and no client-side arithmetic can manufacture one.
 *
 * WHERE MONEY IS SUMMED ON THE DEVICE, AND WHY. `selectClaimableOrdersForSettle` adds up the
 * selected orders' `total` fields to produce the `amount` argument. It has to: the endpoint
 * requires the caller to state the amount and rejects it unless it matches to the cent. Those
 * totals are the server's own figures, echoed back unmodified, and the server recomputes the
 * same sum from the database and refuses on any disagreement — so the device's arithmetic is
 * checked rather than trusted. Nothing else here computes money; the balance shown to staff is
 * the server's `unpaid_total`.
 */
/**
 * Screen-level renders here mount the whole table view and drive async settle flows through
 * act(). On a loaded machine — a Gradle build running alongside the suite, which is exactly how
 * this ran during the settle work — the first render alone has been seen to take several
 * seconds, and Jest's 5s default turned that into three "failures" that were really the CPU
 * being busy. A test that only passes on an idle machine reports the machine, not the code.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert, Text} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockSettleTab = jest.fn();
const mockCloseTable = jest.fn(async () => ({}));
const mockGetTablesWithMeta = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    settleTab: (...args: unknown[]) => mockSettleTab(...(args as [])),
    closeTable: (...args: unknown[]) => mockCloseTable(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) =>
      mockGetTablesWithMeta(...(args as [])),    // Take Payment reads the item list on every refresh. Stubbed to null here: these suites are
    // about the ORDER-level path, and null is exactly what a tab with no line tracking sends, so
    // the screen renders the order list they were written against.
    getTabLines: jest.fn(async () => null),

    completePaymentReliably: jest.fn(async () => true),
    getAuthorizedUsers: jest.fn(async () => []),
    getTerminalInfo: jest.fn(async () => ({permissions: ['orders:update']})),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

const mockProcessPaymentIntent = jest.fn();
jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...args: unknown[]) =>
    mockProcessPaymentIntent(...(args as [])),
  resolveAmbiguousPaymentWithFinatic: jest.fn(async (_i: string, r: unknown) => r),
  declinedFailureReference: () => 'DECLINED-REF',
  unconfirmedFailureReference: () => 'UNCONFIRMED-REF',
}));

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'terminal-token'),
}));

jest.mock('react-native-qrcode-svg', () => 'QRCode');

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void) => {
    const React_ = jest.requireActual('react');
    React_.useEffect(cb, [cb]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

import TableDetailScreen from '../TableDetailScreen';
import {ApiRequestError} from '../../lib/api';

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** Two rounds on one tab: 150.00 and 100.00. */
function twoRoundTab(
  overrides: {firstPaid?: boolean} = {},
): TableWithTab {
  const firstStatus = overrides.firstPaid ? 'paid' : 'unpaid';
  return {
    id: 'table-9140',
    table_number: 9140,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: overrides.firstPaid ? 100 : 250,
      unpaid_total: overrides.firstPaid ? 100 : 250,
      orders: [
        {
          id: 'order-1',
          order_number: 11,
          total: 150,
          status: 'completed',
          payment_status: firstStatus,
          items: [],
          placed_at: '2026-08-28T08:00:00Z',
          can_settle_card: !overrides.firstPaid,
          can_settle_cash: !overrides.firstPaid,
        },
        {
          id: 'order-2',
          order_number: 12,
          total: 100,
          status: 'completed',
          payment_status: 'unpaid',
          items: [],
          placed_at: '2026-08-28T08:10:00Z',
          can_settle_card: true,
          can_settle_cash: true,
        },
      ],
    },
  };
}

function textOf(node: ReactTestInstance): string {
  const collect = (children: unknown): string => {
    if (typeof children === 'string') {
      return children;
    }
    if (typeof children === 'number') {
      return String(children);
    }
    if (Array.isArray(children)) {
      return children.map(collect).join('');
    }
    return '';
  };
  return node
    .findAllByType(Text)
    .map(t => collect(t.props.children))
    .join(' | ');
}

function buttonWithText(root: ReactTestInstance, label: string) {
  const matches = root
    .findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        textOf(node).includes(label),
      {deep: true},
    )
    .filter(node => typeof node.type !== 'string');
  if (matches.length === 0) {
    throw new Error(
      `No pressable containing: ${label}. Screen text: ${textOf(root)}`,
    );
  }
  return matches[matches.length - 1];
}

async function renderScreen(table: TableWithTab) {
  const navigation = {navigate: jest.fn(), goBack: jest.fn()};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TableDetailScreen
        route={{params: {table}, key: 'k', name: 'TableDetail'} as never}
        navigation={navigation as never}
      />,
    );
  });
  return {tree, navigation};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockImplementation(async () => ({
    tables: [twoRoundTab()],
    cardInFlightTimeoutSeconds: 120,
  }));
  mockProcessPaymentIntent.mockImplementation(async () => ({
    success: true,
    reference: 'GATEWAY-REF-1',
    voucherNo: 'V1',
    businessOrderNo: 'B1',
  }));
  mockSettleTab.mockImplementation(async () => ({
    success: true,
    payment_reference: 'PAY-1',
    method: 'card',
    new_tab_total: 100,
    tab_total_stale: false,
    can_close: false,
    staff_user_id: null,
  }));
});

describe('settling a subset of the tab', () => {
  /**
   * The whole point. One round is selected, and ONLY that round's id and amount reach the
   * server. The order the customer has not paid for is not named in the request at all.
   */
  it('sends only the selected order id and only that order amount', async () => {
    const {tree} = await renderScreen(twoRoundTab());

    // Select the 150.00 round.
    await act(async () => {
      buttonWithText(tree.root, 'Order #11').props.onPress();
    });

    await act(async () => {
      buttonWithText(tree.root, 'Settle Selected').props.onPress();
    });

    expect(mockSettleTab).toHaveBeenCalledTimes(1);
    const [tabId, orderIds, amount] = mockSettleTab.mock.calls[0] as [
      string,
      string[],
      number,
    ];
    expect(tabId).toBe('tab-1');
    expect(orderIds).toEqual(['order-1']);
    expect(amount).toBe(150);

    // The reader was charged the same figure that was sent to the server — the two are derived
    // from one filtered set precisely so they cannot disagree.
    const [chargedAmount] = mockProcessPaymentIntent.mock.calls[0] as [number];
    expect(chargedAmount).toBe(150);
  });

  /**
   * THE REMAINDER STAYS OPEN AND PAYABLE. After the partial settle the screen refreshes and
   * finds one paid round and one still owing — the tab is not closed, and the outstanding
   * balance shown is the server's new figure, not a locally decremented one.
   */
  it('leaves the unpaid remainder open and payable, and closes nothing', async () => {
    const {tree} = await renderScreen(twoRoundTab());

    // The refresh that follows a settle sees the new server state.
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [twoRoundTab({firstPaid: true})],
      cardInFlightTimeoutSeconds: 120,
    }));

    await act(async () => {
      buttonWithText(tree.root, 'Order #11').props.onPress();
    });
    await act(async () => {
      buttonWithText(tree.root, 'Settle Selected').props.onPress();
    });

    expect(mockCloseTable).not.toHaveBeenCalled();

    const screen = textOf(tree.root);
    // The server's remaining balance.
    expect(screen).toContain('NAD 100.00');
    // And the remaining round can still be settled.
    expect(() => buttonWithText(tree.root, 'Settle Entire Tab')).not.toThrow();
  });

  /**
   * Whole-tab settle is the same call with every settleable id — there is no shorthand, and
   * `order_ids` is required. Asserted so a future "settle all" that sends [] is caught here
   * rather than by a 400 in front of a customer.
   */
  it('settles the whole tab by naming every settleable order', async () => {
    const {tree} = await renderScreen(twoRoundTab());

    await act(async () => {
      buttonWithText(tree.root, 'Settle Entire Tab').props.onPress();
    });

    const [, orderIds, amount] = mockSettleTab.mock.calls[0] as [
      string,
      string[],
      number,
    ];
    expect(orderIds.sort()).toEqual(['order-1', 'order-2']);
    expect(orderIds.length).toBeGreaterThan(0);
    expect(amount).toBe(250);
  });

  /**
   * 409 ALREADY_PAID is the NORMAL outcome when two waiters settle the same round at once, not
   * an exception. It must surface as a failure, must not close anything, and must not be shown
   * as a success.
   */
  it('reports a 409 ALREADY_PAID refusal as a failure and changes nothing', async () => {
    mockSettleTab.mockImplementation(async () => {
      throw new ApiRequestError('Those orders have already been paid.', 409, {
        code: 'ALREADY_PAID',
      });
    });

    const {tree} = await renderScreen(twoRoundTab());

    await act(async () => {
      buttonWithText(tree.root, 'Order #11').props.onPress();
    });
    await act(async () => {
      buttonWithText(tree.root, 'Settle Selected').props.onPress();
    });

    expect(mockCloseTable).not.toHaveBeenCalled();
    const [title, body] = mockAlert.mock.calls[
      mockAlert.mock.calls.length - 1
    ] as [string, string];
    expect(title).toBe('Error');
    expect(body).toContain('already been paid');
  });

  /** An already-paid round is not selectable, so its total can never enter a second charge. */
  it('will not select a round that is already paid', async () => {
    // The screen refreshes from the server on focus, so the mock — not just the route param —
    // has to describe the paid round, or the refresh overwrites the fixture under the test.
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [twoRoundTab({firstPaid: true})],
      cardInFlightTimeoutSeconds: 120,
    }));
    const {tree} = await renderScreen(twoRoundTab({firstPaid: true}));

    await act(async () => {
      buttonWithText(tree.root, 'Order #11').props.onPress();
    });

    // Selecting nothing means the selection bar never appears.
    expect(textOf(tree.root)).not.toContain('Settle Selected');
  });
});
