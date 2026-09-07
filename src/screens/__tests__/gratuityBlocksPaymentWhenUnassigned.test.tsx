/**
 * THE MOUNTED REPRODUCTION OF THE PHYSICAL FAILURE — Digi Cofee, P5, 2026-09-09.
 *
 * ==================================================================================================
 * WHAT THE DEVICE DID THAT NO TEST COULD
 * ==================================================================================================
 *
 * Table 5, a N$20 item selected, gratuity keyed at N$10. The screen showed the gratuity. The reader
 * displayed NAD 20.00 — the bill alone.
 *
 * GratuitySection had always computed `valid` (false when a tip is keyed and nobody is chosen) and
 * its docblock said "The caller DISABLES the charge buttons on this". Nothing read it. So
 * gratuityExtras() emitted {} and the tip vanished before any request was made.
 *
 * ==================================================================================================
 * WHY THIS TEST HAD TO BE MOUNTED
 * ==================================================================================================
 *
 * Every gratuity test before this constructed the state BY HAND —
 * `{tipCents: 500, tipStaffUserId: 'staff-1', valid: true}` — because that is what a person writing
 * a tip test types. That state cannot fail. The failing state is one only the real component
 * produces: an amount keyed, no staff selected, `valid: false`.
 *
 * So this drives the REAL GratuitySection through the REAL screen: tap Add gratuity, type into the
 * amount field, select nobody, then press a payment button. The suites that mocked their way past
 * that component were green while the device was wrong.
 *
 * THE STAFF LIST IS DELIBERATELY NON-EMPTY AND THE TABLE HAS NO OWNER. GratuitySection pre-selects
 * the table's assigned waiter when there is one — with an owner, the tip would be valid and this
 * would test nothing. Table 5 had no assignment, which is exactly why the waiter had to choose and
 * exactly why it failed there.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';

import type {TableWithTab} from '../../types';
import {GRATUITY_NEEDS_STAFF} from '../../constants/gratuityCopy';

const mockGetTablesWithMeta = jest.fn();
const mockGetTabLines = jest.fn();
const mockSettleTab = jest.fn();
const mockAllocateLine = jest.fn();
const mockSettleAllocations = jest.fn();
const mockPrepareSplitPayment = jest.fn();
const mockRecordSplitPayment = jest.fn();
const mockGetAuthorizedUsers = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTablesWithMeta: (...a: unknown[]) => mockGetTablesWithMeta(...(a as [])),
    getTabLines: (...a: unknown[]) => mockGetTabLines(...(a as [])),
    settleTab: (...a: unknown[]) => mockSettleTab(...(a as [])),
    allocateLine: (...a: unknown[]) => mockAllocateLine(...(a as [])),
    settleAllocations: (...a: unknown[]) => mockSettleAllocations(...(a as [])),
    prepareSplitPayment: (...a: unknown[]) => mockPrepareSplitPayment(...(a as [])),
    recordSplitPayment: (...a: unknown[]) => mockRecordSplitPayment(...(a as [])),
    getAuthorizedUsers: (...a: unknown[]) => mockGetAuthorizedUsers(...(a as [])),
    getTerminalInfo: jest.fn(async () => ({
      cardPaymentEnabled: true,
      cashPaymentEnabled: true,
    })),
    closeTable: jest.fn(async () => ({})),
    completePaymentReliably: jest.fn(async () => true),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

/** The reader. If anything reaches it, the guard failed. */
const mockProcessPaymentIntent = jest.fn();
jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...a: unknown[]) => mockProcessPaymentIntent(...(a as [])),
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

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const PLACED_AT = '2026-09-09T18:00:00.000Z';

/** Table 5 as it stood: one unpaid order, no assigned waiter. */
function tableFive(): TableWithTab {
  return {
    id: 'table-5',
    table_number: 5,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-5',
      status: 'open',
      total: 20,
      unpaid_total: 20,
      orders: [
        {
          id: 'order-1',
          order_number: 44,
          total: 20,
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
      id: 'tab-5',
      table_number: 5,
      status: 'open',
      total: 20,
      opened_at: PLACED_AT,
      opened_by_user_id: 'u1',
    },
    orders: [
      {
        order_id: 'order-1',
        order_number: 44,
        order_instructions: null,
        order_total: 20,
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
            total_cents: 2000,
          },
        ],
      },
    ],
    summary: {total_lines: 1, outstanding: 0, ready: 1, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
  };
}

const byTestId = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findAll(n => n.props?.testID === id);

function renderedText(json: unknown): string {
  if (json == null) return '';
  if (typeof json === 'string' || typeof json === 'number') return String(json);
  if (Array.isArray(json)) return json.map(renderedText).join(' ');
  const node = json as {children?: unknown; props?: {children?: unknown}};
  return renderedText(node.children ?? node.props?.children ?? null);
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(TableDetailScreen, {
        // owner: null — the table has NO assigned waiter, so GratuitySection cannot pre-select
        // anyone and the tip stays unassigned. That is the state that fails.
        route: {params: {table: tableFive(), owner: null}},
        navigation: {
          navigate: jest.fn(),
          goBack: jest.fn(),
          setOptions: jest.fn(),
          addListener: jest.fn(() => jest.fn()),
        },
      } as never),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

/** Tick the one item, which is what routes to the split path. */
async function selectTheItem(tree: renderer.ReactTestRenderer) {
  const [row] = byTestId(tree, 'take-payment-line-line-steak');
  await act(async () => {
    await row.props.onPress();
  });
}

/** Key a gratuity through the REAL component, choosing nobody. */
async function keyGratuityWithNoStaff(tree: renderer.ReactTestRenderer, amount: string) {
  const [add] = byTestId(tree, 'gratuity-add');
  await act(async () => {
    await add.props.onPress();
  });
  const [input] = byTestId(tree, 'gratuity-amount');
  await act(async () => {
    input.props.onChangeText(amount);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const pressWithText = async (tree: renderer.ReactTestRenderer, label: string) => {
  const hits = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && renderedText(n).includes(label),
  );
  await act(async () => {
    await hits[hits.length - 1].props.onPress();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTablesWithMeta.mockResolvedValue({
    tables: [tableFive()],
    cardInFlightTimeoutSeconds: 120,
  });
  mockGetTabLines.mockResolvedValue(linesPayload());
  // A NON-EMPTY staff list: the picker renders choices and the waiter simply does not pick one.
  // An empty list would render "no staff" and test a different branch entirely.
  mockGetAuthorizedUsers.mockResolvedValue([
    {user_id: 'staff-1', name: 'Ana'},
    {user_id: 'staff-2', name: 'Ben'},
  ]);
});

describe('THE PHYSICAL FAILURE, REPRODUCED', () => {
  it('the gratuity renders — the waiter can see what they keyed', async () => {
    /**
     * The half that made it invisible. The screen showed N$10 the entire time, which is why nobody
     * suspected the tip had been discarded.
     */
    const tree = await mount();
    await selectTheItem(tree);
    await keyGratuityWithNoStaff(tree, '10.00');

    expect(byTestId(tree, 'gratuity-section').length).toBeGreaterThan(0);
    expect(byTestId(tree, 'gratuity-amount')[0].props.value).toBe('10.00');
    // The picker is showing and nobody is selected.
    expect(byTestId(tree, 'gratuity-picker').length).toBeGreaterThan(0);
    expect(byTestId(tree, 'gratuity-selected')).toHaveLength(0);
  });

  it('SETTLE SELECTED IS BLOCKED, and says why', async () => {
    /**
     * THE ASSERTION THIS SUITE EXISTS FOR. Before the guard, this charged NAD 20.00 and the N$10
     * was gone. It must now refuse, name the reason, and reach no reader.
     */
    const tree = await mount();
    await selectTheItem(tree);
    await keyGratuityWithNoStaff(tree, '10.00');
    await pressWithText(tree, 'Settle Selected');

    expect(mockAlert).toHaveBeenCalledWith(expect.anything(), GRATUITY_NEEDS_STAFF);
    // And nothing was charged, allocated or settled.
    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
    expect(mockPrepareSplitPayment).not.toHaveBeenCalled();
    expect(mockAllocateLine).not.toHaveBeenCalled();
    expect(mockSettleTab).not.toHaveBeenCalled();
  });

  it('TAKE CASH is blocked too', async () => {
    // payment_tips.staff_user_id is NOT NULL: a cash tip with nobody to pay it to is equally
    // unrecordable, and would be dropped equally silently.
    const tree = await mount();
    await selectTheItem(tree);
    await keyGratuityWithNoStaff(tree, '10.00');
    await pressWithText(tree, 'Take Cash');

    expect(mockAlert).toHaveBeenCalledWith(expect.anything(), GRATUITY_NEEDS_STAFF);
    expect(mockSettleAllocations).not.toHaveBeenCalled();
    expect(mockAllocateLine).not.toHaveBeenCalled();
  });

  it('SETTLE ENTIRE TAB is blocked too', async () => {
    /**
     * REACHED THROUGH THE SELECTION BAR, and it has to be.
     *
     * GratuitySection renders ONLY in the selection-mode bottom bar. The default bar carries
     * Settle Entire Tab and Take Cash with no gratuity affordance at all, so a keyed tip cannot
     * exist there -- the guard on that path is defensive rather than reachable. Settle Entire Tab
     * is rendered in BOTH bars, and this is the one a waiter can actually reach with a tip keyed.
     *
     * The first version of this test pressed it from the default bar and failed looking for a
     * gratuity control that is not rendered there. That was the test being wrong about the screen,
     * not the screen being wrong.
     */
    const tree = await mount();
    await selectTheItem(tree);
    await keyGratuityWithNoStaff(tree, '10.00');
    await pressWithText(tree, 'Settle Entire Tab');

    expect(mockAlert).toHaveBeenCalledWith(expect.anything(), GRATUITY_NEEDS_STAFF);
    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
  });
});

describe('THE POSITIVE CONTROLS — payment is not simply broken', () => {
  it('NO gratuity at all still charges', async () => {
    /**
     * Without this, a guard that refused everything would satisfy every assertion above while
     * making the terminal unable to take money at all — a far worse outcome than the defect.
     */
    mockPrepareSplitPayment.mockResolvedValue({
      intentId: '99999999-9999-4999-8999-999999999999',
      merchantOrderNo: 'FT-SPLIT-1',
      amountCents: 2000,
      allocationIds: ['alloc-1'],
    });
    mockProcessPaymentIntent.mockResolvedValue({
      success: true,
      outcomeKind: 'success',
      voucherNo: 'V1',
    });
    mockRecordSplitPayment.mockResolvedValue({
      intentId: '99999999-9999-4999-8999-999999999999',
      status: 'confirmed',
      settledAllocationIds: ['alloc-1'],
    });
    mockAllocateLine.mockResolvedValue({
      order_id: 'order-1',
      line_id: 'line-steak',
      line_total_cents: 2000,
      allocations: [
        {id: 'alloc-1', allocated_to: 'Table', quantity_allocated: 1, amount_cents: 2000},
      ],
    });

    const tree = await mount();
    await selectTheItem(tree);
    await pressWithText(tree, 'Settle Selected');

    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockAlert).not.toHaveBeenCalledWith(expect.anything(), GRATUITY_NEEDS_STAFF);
  });

  it('a gratuity is REMOVED and payment proceeds', async () => {
    /**
     * The recovery a waiter actually performs. Keying a tip and then removing it must clear the
     * block — otherwise the refusal is a dead end and the table cannot be settled at all.
     */
    mockPrepareSplitPayment.mockResolvedValue({
      intentId: '99999999-9999-4999-8999-999999999999',
      merchantOrderNo: 'FT-SPLIT-1',
      amountCents: 2000,
      allocationIds: ['alloc-1'],
    });
    mockProcessPaymentIntent.mockResolvedValue({success: true, outcomeKind: 'success'});
    mockRecordSplitPayment.mockResolvedValue({intentId: 'i', status: 'confirmed'});
    mockAllocateLine.mockResolvedValue({
      order_id: 'order-1',
      line_id: 'line-steak',
      line_total_cents: 2000,
      allocations: [
        {id: 'alloc-1', allocated_to: 'Table', quantity_allocated: 1, amount_cents: 2000},
      ],
    });

    const tree = await mount();
    await selectTheItem(tree);
    await keyGratuityWithNoStaff(tree, '10.00');

    const [remove] = byTestId(tree, 'gratuity-remove');
    await act(async () => {
      await remove.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    await pressWithText(tree, 'Settle Selected');
    expect(mockAlert).not.toHaveBeenCalledWith(expect.anything(), GRATUITY_NEEDS_STAFF);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
  });
});
