/**
 * A CARD TAB SETTLE THE SERVER REFUSES BEFORE THE READER OPENS (Sprint 2026-09-29, F-TERMPAY task 3).
 *
 * prepare-payment answers 409 SETTLEMENT_SET_NOT_CLAIMABLE when an order in the selection was
 * paid, cancelled or held for review elsewhere, and ORDER_NOTHING_OWED when the lead owes nothing.
 * processPaymentIntent returns those as not_started with `prepareRefusal` (proved against the real
 * payment.ts, reader-launch count 0, in src/lib/__tests__/prepareRefusalSettlementSet.test.ts).
 * This suite pins what the SCREEN does with it: the reason in words, a refresh, no Finatic verify,
 * no failure report, no automatic retry -- and a retry by the waiter charges the new state only.
 *
 * Harness adapted from settleSelectedOrders.test.tsx.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert, Text} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockSettleTab = jest.fn();
const mockCloseTable = jest.fn(async () => ({}));
const mockGetTablesWithMeta = jest.fn();
const mockCompletePaymentReliably = jest.fn(async () => true);
const mockResolveAmbiguous = jest.fn(async (_i: string, r: unknown) => r);

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    settleTab: (...args: unknown[]) => mockSettleTab(...(args as [])),
    closeTable: (...args: unknown[]) => mockCloseTable(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) => mockGetTablesWithMeta(...(args as [])),
    getTabLines: jest.fn(async () =>
      require('../../lib/__tests__/helpers/linesPayload').noLinesPayload(),
    ),
    completePaymentReliably: (...args: unknown[]) => mockCompletePaymentReliably(...(args as [])),
    getAuthorizedUsers: jest.fn(async () => []),
    getTerminalInfo: jest.fn(async () => ({permissions: ['orders:update']})),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

const mockProcessPaymentIntent = jest.fn();
jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...args: unknown[]) => mockProcessPaymentIntent(...(args as [])),
  resolveAmbiguousPaymentWithFinatic: (...args: unknown[]) =>
    mockResolveAmbiguous(...(args as [string, unknown])),
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
import {
  PREPARE_REFUSAL_CANCELLED,
  PREPARE_REFUSAL_HELD,
  PREPARE_REFUSAL_NOTHING_OWED,
  PREPARE_REFUSAL_PAID,
  PREPARE_REFUSAL_TITLE,
  SETTLE_NOTHING_LEFT_AFTER_CARD,
  SETTLE_NOTHING_LEFT_AFTER_CARD_TITLE,
} from '../../constants/settlementRefusalCopy';

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** Two rounds on one tab: 150.00 and 100.00. `secondStatus` is what the SERVER now says of #12. */
function twoRoundTab(secondStatus = 'unpaid'): TableWithTab {
  const secondOpen = secondStatus === 'unpaid';
  return {
    id: 'table-9140',
    table_number: 9140,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: 250,
      unpaid_total: secondOpen ? 250 : 150,
      orders: [
        {
          id: 'order-1',
          order_number: 11,
          total: 150,
          status: 'completed',
          payment_status: 'unpaid',
          items: [],
          placed_at: '2026-08-28T08:00:00Z',
          can_settle_card: true,
          can_settle_cash: true,
        },
        {
          id: 'order-2',
          order_number: 12,
          total: 100,
          status: secondStatus === 'cancelled' ? 'cancelled' : 'completed',
          payment_status: secondStatus,
          items: [],
          placed_at: '2026-08-28T08:10:00Z',
          can_settle_card: secondOpen,
          can_settle_cash: secondOpen,
        },
      ],
    },
  };
}

function textOf(node: ReactTestInstance): string {
  const collect = (children: unknown): string => {
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(collect).join('');
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
      node => typeof node.props?.onPress === 'function' && textOf(node).includes(label),
      {deep: true},
    )
    .filter(node => typeof node.type !== 'string');
  if (matches.length === 0) {
    throw new Error(`No pressable containing: ${label}. Screen text: ${textOf(root)}`);
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

/** What processPaymentIntent returns when prepare-payment refused before the reader opened. */
function refused(rows: Array<[string, number, string]>) {
  return {
    success: false,
    outcomeKind: 'not_started',
    error: 'Part of this bill has already been paid, cancelled, or is held for review.',
    prepareRefusal: {
      code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
      notClaimable: rows.map(([orderId, orderNumber, reason]) => ({orderId, orderNumber, reason})),
      orderIdsOwingNothing: [],
    },
  };
}

function lastAlert(): [string, string] {
  return mockAlert.mock.calls[mockAlert.mock.calls.length - 1] as [string, string];
}

function serverSays(secondStatus: string) {
  mockGetTablesWithMeta.mockImplementation(async () => ({
    tables: [twoRoundTab(secondStatus)],
    cardInFlightTimeoutSeconds: 120,
  }));
}

async function press(tree: renderer.ReactTestRenderer, label: string) {
  await act(async () => {
    buttonWithText(tree.root, label).props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  serverSays('unpaid');
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
    new_tab_total: 0,
    tab_total_stale: false,
    can_close: false,
    staff_user_id: null,
  }));
});

describe('SETTLEMENT_SET_NOT_CLAIMABLE on a card tab settle', () => {
  it.each([
    ['paid', 'paid', PREPARE_REFUSAL_PAID],
    ['cancelled', 'cancelled', PREPARE_REFUSAL_CANCELLED],
    ['held', 'amount_mismatch_hold', PREPARE_REFUSAL_HELD],
  ])(
    'a %s order: the reason in words, the tab refreshed, nothing reported, nothing retried',
    async (reason, serverStatus, sentence) => {
      const {tree} = await renderScreen(twoRoundTab());
      const refreshesBefore = mockGetTablesWithMeta.mock.calls.length;
      mockProcessPaymentIntent.mockResolvedValueOnce(refused([['order-2', 12, reason]]));
      serverSays(serverStatus);

      await press(tree, 'Settle Entire Tab');

      const [title, body] = lastAlert();
      expect(title).toBe(PREPARE_REFUSAL_TITLE);
      expect(body.startsWith(sentence)).toBe(true);
      expect(body).toContain('#12');
      // One attempt, and no automatic second one.
      expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
      // Not a card outcome: no Finatic verify, no failure report, no settle.
      expect(mockResolveAmbiguous).not.toHaveBeenCalled();
      expect(mockCompletePaymentReliably).not.toHaveBeenCalled();
      expect(mockSettleTab).not.toHaveBeenCalled();
      // The tab was re-read from the server.
      expect(mockGetTablesWithMeta.mock.calls.length).toBeGreaterThan(refreshesBefore);
    },
  );

  it('mixed valid + invalid: the retry after the refresh charges only what is still open', async () => {
    const {tree} = await renderScreen(twoRoundTab());
    mockProcessPaymentIntent.mockResolvedValueOnce(refused([['order-2', 12, 'paid']]));
    serverSays('paid');

    await press(tree, 'Settle Entire Tab');
    const [firstAmount, firstIds] = mockProcessPaymentIntent.mock.calls[0] as [number, string];
    expect(firstIds.split(',').sort()).toEqual(['order-1', 'order-2']);
    expect(firstAmount).toBe(250);

    // The waiter chooses again, on the refreshed tab.
    await press(tree, 'Settle Entire Tab');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(2);
    const [secondAmount, secondIds] = mockProcessPaymentIntent.mock.calls[1] as [number, string];
    expect(secondIds).toBe('order-1');
    expect(secondAmount).toBe(150);
    const [, settledIds, settledAmount] = mockSettleTab.mock.calls[0] as [string, string[], number];
    expect(settledIds).toEqual(['order-1']);
    expect(settledAmount).toBe(150);
  });

  it('a refused order leaves the selection even when the refresh fails', async () => {
    const {tree} = await renderScreen(twoRoundTab());
    // The refresh itself fails, so the stale tab stays on screen. The named order must still be
    // gone from the selection, or the next tap resends the refused set.
    mockGetTablesWithMeta.mockImplementation(async () => {
      throw new Error('network down');
    });
    mockProcessPaymentIntent.mockResolvedValueOnce(refused([['order-2', 12, 'paid']]));

    await press(tree, 'Order #11');
    await press(tree, 'Order #12');
    await press(tree, 'Settle Selected');
    const firstIds = (mockProcessPaymentIntent.mock.calls[0] as [number, string])[1];
    expect(firstIds.split(',').sort()).toEqual(['order-1', 'order-2']);

    await press(tree, 'Settle Selected');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(2);
    expect((mockProcessPaymentIntent.mock.calls[1] as [number, string])[1]).toBe('order-1');
  });

  it('ORDER_NOTHING_OWED: the nothing-owed sentence, nothing reported', async () => {
    const {tree} = await renderScreen(twoRoundTab());
    mockProcessPaymentIntent.mockResolvedValueOnce({
      success: false,
      outcomeKind: 'not_started',
      prepareRefusal: {code: 'ORDER_NOTHING_OWED', notClaimable: [], orderIdsOwingNothing: ['order-1']},
    });
    await press(tree, 'Settle Entire Tab');
    expect(lastAlert()).toEqual([PREPARE_REFUSAL_TITLE, PREPARE_REFUSAL_NOTHING_OWED]);
    expect(mockCompletePaymentReliably).not.toHaveBeenCalled();
    expect(mockSettleTab).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a plain not_started (no typed refusal) still takes the failure path', async () => {
    const {tree} = await renderScreen(twoRoundTab());
    mockProcessPaymentIntent.mockResolvedValueOnce({
      success: false,
      outcomeKind: 'not_started',
      error: 'The card machine could not be started',
    });
    await press(tree, 'Settle Entire Tab');
    expect(mockCompletePaymentReliably).toHaveBeenCalledTimes(1);
    expect(lastAlert()[0]).toBe('Error');
  });
});

describe('NOTHING_LEFT_TO_CHARGE from /settle AFTER the card went through', () => {
  it('says the card WAS charged, does not retry, and refreshes', async () => {
    const {tree} = await renderScreen(twoRoundTab());
    const refreshesBefore = mockGetTablesWithMeta.mock.calls.length;
    mockSettleTab.mockImplementation(async () => {
      throw new ApiRequestError('Those orders have already been paid for.', 409, {
        code: 'NOTHING_LEFT_TO_CHARGE',
      });
    });
    await press(tree, 'Settle Entire Tab');
    expect(lastAlert()).toEqual([SETTLE_NOTHING_LEFT_AFTER_CARD_TITLE, SETTLE_NOTHING_LEFT_AFTER_CARD]);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockSettleTab).toHaveBeenCalledTimes(1);
    expect(mockGetTablesWithMeta.mock.calls.length).toBeGreaterThan(refreshesBefore);
  });
});
