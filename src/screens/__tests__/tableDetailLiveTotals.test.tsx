/**
 * THE TABLE SCREEN CHARGES THE LIVE BILL, NOT THE STORED ONE -- sprint 2026-09-28.
 *
 * The Riviera shape from the sprint brief, mounted through the real TableDetailScreen: one order of
 * N$1,945 whose Wish You Were Here, Salmon and Burger were reduced 2 -> 1 (each original line voided
 * whole, three replacement orders carrying one unit each). The reader and /settle must both be
 * asked for N$1,205 -- never N$1,945 and never N$2,685 -- and a bill the device could not read must
 * not be charged at all.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert, StyleSheet, Text} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockSettleTab = jest.fn();
const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    settleTab: (...args: unknown[]) => mockSettleTab(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) => mockGetTablesWithMeta(...(args as [])),
    getTabLines: (...args: unknown[]) => mockGetTabLines(...(args as [])),
    closeTable: jest.fn(async () => ({})),
    completePaymentReliably: jest.fn(async () => true),
    getAuthorizedUsers: jest.fn(async () => []),
    getTerminalInfo: jest.fn(async () => ({permissions: ['orders:update']})),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

const mockProcessPaymentIntent = jest.fn();
jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...args: unknown[]) => mockProcessPaymentIntent(...(args as [])),
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
import {line, money, payloadWith} from '../../lib/__tests__/helpers/linesPayload';
import {LIVE_TOTAL_UNAVAILABLE_TITLE} from '../../constants/liveTotalCopy';

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const ORDER = (id: string, number: number, total: number) => ({
  id,
  order_number: number,
  total,
  status: 'completed',
  payment_status: 'unpaid',
  items: [],
  placed_at: '2026-09-28T18:00:00.000Z',
  can_settle_card: true,
  can_settle_cash: true,
  card_payment_in_flight: false,
  card_in_flight_seconds: null,
});

function rivieraTable(): TableWithTab {
  return {
    id: 'table-12',
    table_number: 12,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-riviera',
      status: 'open',
      total: 2685,
      unpaid_total: 1205,
      orders: [
        ORDER('orig', 160, 1945),
        ORDER('r-wywh', 161, 190),
        ORDER('r-salmon', 162, 460),
        ORDER('r-burger', 163, 90),
      ],
    },
  } as unknown as TableWithTab;
}

function rivieraLines(withFinancials: boolean) {
  const financials = {
    tab: money({original_cents: 268500, voided_cents: 148000}),
    orders: {
      orig: money({original_cents: 194500, voided_cents: 148000}),
      'r-wywh': money({original_cents: 19000}),
      'r-salmon': money({original_cents: 46000}),
      'r-burger': money({original_cents: 9000}),
    },
  };
  return payloadWith(
    [
      {
        id: 'orig',
        number: 160,
        total: 1945,
        lines: [
          line({id: 'modena', name: 'Modena', cents: 24000}),
          line({id: 'wywh', name: 'Wish You Were Here', quantity: 2, cents: 38000, voided: true}),
          line({id: 'salmon', name: 'Salmon', quantity: 2, cents: 92000, voided: true}),
          line({id: 'burger', name: 'Burger', quantity: 2, cents: 18000, voided: true}),
          line({id: 'jameson', name: 'Jameson', cents: 8000}),
          line({id: 'hansa', name: 'Hansa', cents: 8000}),
          line({id: 'soft', name: 'Soft drink', cents: 3500}),
          line({id: 'mixers', name: 'Mixers', cents: 3000}),
        ],
      },
      {id: 'r-wywh', number: 161, total: 190, lines: [line({id: 'wywh-1', cents: 19000})]},
      {id: 'r-salmon', number: 162, total: 460, lines: [line({id: 'salmon-1', cents: 46000})]},
      {id: 'r-burger', number: 163, total: 90, lines: [line({id: 'burger-1', cents: 9000})]},
    ],
    withFinancials ? financials : undefined,
  );
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

function pressableWithText(root: ReactTestInstance, label: string) {
  const matches = root
    .findAll(node => typeof node.props?.onPress === 'function' && textOf(node).includes(label), {
      deep: true,
    })
    .filter(node => typeof node.type !== 'string');
  if (matches.length === 0) {
    throw new Error(`No pressable containing: ${label}. Screen text: ${textOf(root)}`);
  }
  return matches[matches.length - 1];
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TableDetailScreen
        route={{params: {table: rivieraTable()}} as never}
        navigation={{navigate: jest.fn(), goBack: jest.fn()} as never}
      />,
    );
  });
  return tree;
}

async function settleEntireTab(tree: renderer.ReactTestRenderer) {
  await act(async () => {
    await pressableWithText(tree.root, 'Settle Entire Tab').props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockResolvedValue({tables: [rivieraTable()], cardInFlightTimeoutSeconds: 120});
  mockProcessPaymentIntent.mockResolvedValue({
    success: true,
    reference: 'GATEWAY-REF',
    voucherNo: 'V1',
    businessOrderNo: 'B1',
  });
  mockSettleTab.mockResolvedValue({
    success: true,
    payment_reference: 'PAY-1',
    method: 'card',
    new_tab_total: 0,
    can_close: true,
    staff_user_id: null,
  });
});

describe.each([
  ['financials absent (older server)', false],
  ['financials present (C2)', true],
])('Riviera, %s', (_label, withFinancials) => {
  beforeEach(() => {
    mockGetTabLines.mockResolvedValue(rivieraLines(withFinancials));
  });

  it('charges the reader and settles for N$1,205 -- not 1,945, not 2,685', async () => {
    const tree = await mount();
    await settleEntireTab(tree);

    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    const [charged] = mockProcessPaymentIntent.mock.calls[0] as [number];
    expect(charged).toBe(1205);

    expect(mockSettleTab).toHaveBeenCalledTimes(1);
    const [, orderIds, amount] = mockSettleTab.mock.calls[0] as [string, string[], number];
    expect(orderIds).toEqual(['orig', 'r-wywh', 'r-salmon', 'r-burger']);
    expect(amount).toBe(1205);
  });

  it('shows the original beside the live figure, and the voided lines struck and inert', async () => {
    const tree = await mount();
    const note = tree.root.findByProps({testID: 'take-payment-order-voids-orig'});
    expect(textOf(note.parent as ReactTestInstance)).toContain(
      'NAD 1945.00 original · NAD 465.00 after voids',
    );

    for (const id of ['wywh', 'salmon', 'burger']) {
      const row = tree.root.findByProps({testID: `take-payment-voided-${id}`});
      expect(typeof row.props.onPress).toBe('undefined');
      const struck = row
        .findAllByType(Text)
        .filter(t => StyleSheet.flatten(t.props.style)?.textDecorationLine === 'line-through');
      expect(struck.length).toBeGreaterThanOrEqual(2); // the name and the amount
    }
    // Live lines are unaffected: still a take-payment row, still selectable.
    expect(tree.root.findAllByProps({testID: 'take-payment-line-modena'}).length).toBeGreaterThan(0);
  });
});

describe('a bill the device could not read', () => {
  it('is not charged: no reader, no settle, and the waiter is told to refresh', async () => {
    mockGetTabLines.mockRejectedValue(new Error('network down'));
    const tree = await mount();
    await settleEntireTab(tree);

    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
    expect(mockSettleTab).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(LIVE_TOTAL_UNAVAILABLE_TITLE, expect.any(String));
  });
});
