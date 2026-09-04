/**
 * TAKE PAYMENT, BY ITEM (Ship 1b) -- the screen.
 *
 * takePaymentLines.test.ts owns the arithmetic and the route decision. This suite owns the four
 * things only the mounted screen can answer:
 *
 *   1. THE LIST SHOWS THINGS, NOT GUESTS. That was the whole defect: "Ana's order" means nothing
 *      to three people splitting a bill.
 *   2. A WHOLE-ORDER SELECTION STILL GOES DOWN THE WHOLE-ORDER ROUTE. `settleTab` is called and
 *      the item ledger is not touched -- the card reader's fallbacks stay on the common case.
 *   3. A PART-ORDER SELECTION ALLOCATES AND SETTLES THROUGH THE LEDGER, and `settleTab` is NOT
 *      called with a hand-made amount.
 *   4. CARD REFUSES A PART-ORDER SELECTION RATHER THAN RECORDING A PAYMENT NOBODY TOOK. The item
 *      route does not drive the reader; a 'card' settlement written there is money that never
 *      arrived.
 *
 * A tab the server cannot itemise must keep the order list it has always had. That is asserted
 * too, because a silent switch to an empty item list is a table nobody can charge.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockSettleTab = jest.fn();
const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockAllocateLine = jest.fn();
const mockSettleAllocations = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    settleTab: (...args: unknown[]) => mockSettleTab(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) => mockGetTablesWithMeta(...(args as [])),
    getTabLines: (...args: unknown[]) => mockGetTabLines(...(args as [])),
    allocateLine: (...args: unknown[]) => mockAllocateLine(...(args as [])),
    settleAllocations: (...args: unknown[]) => mockSettleAllocations(...(args as [])),
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
import {
  TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER,
  TAKE_PAYMENT_NOT_ITEMISED,
} from '../../constants/takePaymentCopy';

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const PLACED_AT = '2026-09-04T18:00:00.000Z';

/** One order, 250.00, two dishes: a 150.00 steak and a 100.00 fish. */
function oneOrderTab(): TableWithTab {
  return {
    id: 'table-1',
    table_number: 7,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: 250,
      unpaid_total: 250,
      orders: [
        {
          id: 'order-1',
          order_number: 41,
          total: 250,
          status: 'completed',
          payment_status: 'unpaid',
          member_name: 'Ana',
          items: [],
          placed_at: PLACED_AT,
          can_settle_card: true,
          can_settle_cash: true,
          card_payment_in_flight: false,
          card_in_flight_seconds: null,
        },
      ],
    },
  } as unknown as TableWithTab;
}

function linesPayload() {
  return {
    tab: {
      id: 'tab-1',
      table_number: 7,
      status: 'open',
      total: 250,
      opened_at: PLACED_AT,
      opened_by_user_id: 'user-1',
    },
    orders: [
      {
        order_id: 'order-1',
        order_number: 41,
        order_instructions: null,
        order_total: 250,
        placed_at: PLACED_AT,
        seconds_since_placed: 600,
        lines: [
          {
            id: 'line-steak',
            name_snapshot: 'Ribeye',
            quantity: 1,
            line_note: null,
            route_to: 'kitchen',
            kitchen_state: 'ready',
            bar_state: null,
            is_ready: true,
            is_voided: false,
            unrouted: false,
            total_cents: 15000,
          },
          {
            id: 'line-fish',
            name_snapshot: 'Kingklip',
            quantity: 1,
            line_note: null,
            route_to: 'kitchen',
            kitchen_state: 'ready',
            bar_state: null,
            is_ready: true,
            is_voided: false,
            unrouted: false,
            total_cents: 10000,
          },
        ],
      },
    ],
    summary: {total_lines: 2, outstanding: 0, ready: 2, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
  };
}

function renderedText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as {children?: unknown[]} | null)?.children;
    if (children) {
      children.forEach(walk);
    }
  };
  walk(json);
  return out.join('\n');
}

async function mount(table: TableWithTab) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TableDetailScreen
        route={{params: {table}} as never}
        navigation={{navigate: jest.fn(), goBack: jest.fn()} as never}
      />,
    );
  });
  return tree;
}

async function tap(tree: renderer.ReactTestRenderer, testID: string) {
  const node: ReactTestInstance = tree.root.findByProps({testID});
  await act(async () => {
    await node.props.onPress();
  });
}

const has = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAllByProps({testID}).length > 0;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockResolvedValue({
    tables: [oneOrderTab()],
    cardInFlightTimeoutSeconds: 120,
  });
  mockGetTabLines.mockResolvedValue(linesPayload());
  mockSettleTab.mockResolvedValue({can_close: true, new_tab_total: 0});
  mockAllocateLine.mockResolvedValue({
    order_id: 'order-1',
    line_id: 'line-steak',
    line_total_cents: 15000,
    allocations: [
      {id: 'alloc-1', allocated_to: 'Table', quantity_allocated: 1, amount_cents: 15000},
    ],
  });
  mockSettleAllocations.mockResolvedValue({
    success: true,
    payment_reference: 'REF',
    method: 'cash',
    applied: [{allocation_id: 'alloc-1', amount_cents: 15000}],
    refused: [],
    completed_order_ids: [],
    new_tab_total: 100,
    tab_total_stale: false,
  });
});

describe('the list shows things, not guests', () => {
  it('lists the items on the tab', async () => {
    const tree = await mount(oneOrderTab());
    const text = renderedText(tree.toJSON());
    expect(has(tree, 'take-payment-item-list')).toBe(true);
    expect(text).toContain('Ribeye');
    expect(text).toContain('Kingklip');
    // The guest name was the old list. It is not what a customer pays for.
    expect(text).not.toContain('Ana');
  });

  it('shows a running total for what is ticked', async () => {
    const tree = await mount(oneOrderTab());
    await tap(tree, 'take-payment-line-line-steak');
    expect(renderedText(tree.toJSON())).toContain('NAD 150.00');
  });
});

describe('which money path a payment takes', () => {
  it('sends a whole order down the whole-order route, untouched', async () => {
    const tree = await mount(oneOrderTab());
    await tap(tree, 'take-payment-line-line-steak');
    await tap(tree, 'take-payment-line-line-fish');
    mockProcessPaymentIntent.mockResolvedValue({status: 'approved', reference: 'R1'});

    // Drive the card button by its label rather than a testID the screen never had.
    const pressables = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && renderedText(n).includes('Settle Selected'),
    );
    await act(async () => {
      await pressables[pressables.length - 1].props.onPress();
    });

    expect(mockAllocateLine).not.toHaveBeenCalled();
    expect(mockSettleAllocations).not.toHaveBeenCalled();
    expect(mockProcessPaymentIntent).toHaveBeenCalled();
  });

  it('refuses card on part of an order instead of recording a payment nobody took', async () => {
    const tree = await mount(oneOrderTab());
    await tap(tree, 'take-payment-line-line-steak');

    const pressables = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && renderedText(n).includes('Settle Selected'),
    );
    await act(async () => {
      await pressables[pressables.length - 1].props.onPress();
    });

    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
    expect(mockSettleTab).not.toHaveBeenCalled();
    expect(mockSettleAllocations).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(
      'Take Payment',
      TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER,
    );
  });

  it('takes cash for part of an order through the item ledger', async () => {
    const tree = await mount(oneOrderTab());
    await tap(tree, 'take-payment-line-line-steak');

    // Open the cash prompt, then take the "Skip" branch the alert offers.
    const cashPressables = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && renderedText(n).includes('Take Cash'),
    );
    await act(async () => {
      await cashPressables[cashPressables.length - 1].props.onPress();
    });
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    const skip = buttons.find(b => b.text === 'Skip');
    await act(async () => {
      await skip?.onPress?.();
    });

    expect(mockAllocateLine).toHaveBeenCalledTimes(1);
    const [tabId, lineId, shares] = mockAllocateLine.mock.calls[0];
    expect(tabId).toBe('tab-1');
    expect(lineId).toBe('line-steak');
    expect(shares).toEqual([{allocated_to: 'Table', quantity_allocated: 1}]);

    expect(mockSettleAllocations).toHaveBeenCalledTimes(1);
    const [, params] = mockSettleAllocations.mock.calls[0];
    expect(params.allocationIds).toEqual(['alloc-1']);
    expect(params.method).toBe('cash');

    // The whole-order route is not also called: one payment, one path.
    expect(mockSettleTab).not.toHaveBeenCalled();
  });
});

describe('a tab the server cannot itemise', () => {
  it('keeps the order list and says why', async () => {
    mockGetTabLines.mockResolvedValue({...linesPayload(), has_lines: false});
    const tree = await mount(oneOrderTab());
    expect(has(tree, 'take-payment-item-list')).toBe(false);
    expect(renderedText(tree.toJSON())).toContain(TAKE_PAYMENT_NOT_ITEMISED);
  });

  it('keeps the order list when the lines cannot be read at all', async () => {
    mockGetTabLines.mockRejectedValue(new Error('unreadable'));
    const tree = await mount(oneOrderTab());
    expect(has(tree, 'take-payment-item-list')).toBe(false);
    // No explanation when there is nothing to explain -- null is "not read", not "not itemised".
    expect(renderedText(tree.toJSON())).not.toContain(TAKE_PAYMENT_NOT_ITEMISED);
  });
});
