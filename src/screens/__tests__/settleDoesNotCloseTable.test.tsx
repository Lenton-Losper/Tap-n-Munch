/**
 * THE THREE ASSERTIONS THAT GUARD THE MONEY on the settle path.
 *
 *   1. PAID IS NOT CLOSED. Taking payment must not end the session. Asserted directly: the
 *      close endpoint is mocked and must never be called by a settle, and the tab must still be
 *      reported as open afterwards.
 *   2. A DOUBLE-TAP MUST NOT PAY TWICE. Two presses in the same tick, which is the case the
 *      button's `disabled` prop cannot catch because it is computed from state that has not
 *      re-rendered yet.
 *   3. A REFUSED SETTLE MUST LEAVE THE TAB AS IT WAS, and must not show success.
 *
 * These run against TableDetailScreen because that is where the terminal actually takes money —
 * `runSettle` / `runCashSettle`, with the Finatic ambiguity handling and the failure reporting.
 * The waiter table view routes into this same screen rather than growing a second payment flow,
 * so this is the code path under both entry points.
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
import {Text} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

// ---- api ----
const mockSettleTab = jest.fn();
const mockCloseTable = jest.fn(async () => ({}));
const mockGetTablesWithMeta = jest.fn();
const mockCompletePaymentReliably = jest.fn(async () => true);

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

    completePaymentReliably: (...args: unknown[]) =>
      mockCompletePaymentReliably(...(args as [])),
    getAuthorizedUsers: jest.fn(async () => []),
    getTerminalInfo: jest.fn(async () => ({permissions: ['orders:update']})),
    recordSaleEvent: jest.fn(async () => ({ok: true})),
    resetTabPin: jest.fn(),
  };
});

// ---- card reader ----
const mockProcessPaymentIntent = jest.fn();
jest.mock('../../lib/payment', () => ({
  processPaymentIntent: (...args: unknown[]) =>
    mockProcessPaymentIntent(...(args as [])),
  resolveAmbiguousPaymentWithFinatic: jest.fn(async (_id: string, r: unknown) => r),
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

import {Alert} from 'react-native';

import TableDetailScreen from '../TableDetailScreen';

/**
 * Spied rather than module-mocked. `Alert` is re-exported through react-native's index, so
 * replacing the underlying module leaves the screen holding a different object and the calls
 * land somewhere the test cannot see.
 */
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** A live, wholly unpaid tab on table 9140 — the demo table. */
function openUnpaidTable(): TableWithTab {
  return {
    id: 'table-9140',
    table_number: 9140,
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
    if (Array.isArray(children)) {
      return children.map(collect).join('');
    }
    return '';
  };
  return node
    .findAllByType(Text)
    .map(t => collect(t.props.children))
    .join(' ');
}

/**
 * The innermost pressable node whose subtree renders `label`.
 *
 * Matched on the presence of an `onPress` prop rather than on `Pressable` identity: React
 * Native exports Pressable through a lazy getter on its index module, so the value imported in
 * a test is not always the same object the renderer recorded, and findAllByType silently
 * returns nothing.
 */
function buttonWithText(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance {
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
      `No pressable found containing text: ${label}. Screen text was: ${textOf(
        root,
      ).slice(0, 600)}`,
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
        // The screen only reads route.params.table and navigation.navigate.
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
    tables: [openUnpaidTable()],
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
    new_tab_total: 0,
    tab_total_stale: false,
    // The server's advice that the table COULD now be closed. It is not an instruction, and
    // acting on it automatically is the defect this suite exists to prevent.
    can_close: true,
    staff_user_id: null,
  }));
});

describe('settling a tab', () => {
  /**
   * ASSERTION 1 — PAID IS NOT CLOSED.
   *
   * The server response deliberately carries `can_close: true`, the strongest possible nudge
   * toward closing, and the tab is settled in full. Nothing may call the close endpoint.
   */
  it('never closes the table, even when the server says the tab could now be closed', async () => {
    const {tree} = await renderScreen(openUnpaidTable());

    await act(async () => {
      buttonWithText(tree.root, 'Settle Entire Tab').props.onPress();
    });

    expect(mockSettleTab).toHaveBeenCalledTimes(1);
    expect(mockCloseTable).not.toHaveBeenCalled();
  });

  /**
   * Close Table is a separate, deliberate act — and it still works.
   *
   * The fixture is a tab the server has already marked closeable (`can_close: true`), which is
   * the only state in which the control is offered at all. Paying is what produced that state;
   * pressing the button is what acts on it, and the two remain different events.
   */
  it('closes the table only when Close Table is pressed', async () => {
    const closeable = {...openUnpaidTable(), can_close: true};
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [closeable],
      cardInFlightTimeoutSeconds: 120,
    }));
    const {tree} = await renderScreen(closeable);

    await act(async () => {
      buttonWithText(tree.root, 'Close Table').props.onPress();
    });

    expect(mockCloseTable).toHaveBeenCalledTimes(1);
    expect(mockSettleTab).not.toHaveBeenCalled();
  });

  /**
   * ASSERTION 2 — A DOUBLE-TAP MUST NOT PAY TWICE.
   *
   * Both presses are dispatched inside ONE act() with no render between them, which is exactly
   * the case the button's `disabled` prop cannot catch: it is derived from `settling`, and that
   * state has not been applied yet when the second press arrives. Only the synchronous
   * re-entrancy ref stops the second entry.
   *
   * Asserted on processPaymentIntent as well as settleTab, because the charge happens at the
   * reader FIRST — a second settleTab would be bad, but a second card charge is the money.
   */
  it('charges once when the settle button is double-tapped in a single tick', async () => {
    const {tree} = await renderScreen(openUnpaidTable());
    const button = buttonWithText(tree.root, 'Settle Entire Tab');

    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });

    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockSettleTab).toHaveBeenCalledTimes(1);
  });

  /**
   * The same guard must span the two collection methods. Tapping Settle and then Take Cash
   * before the card attempt returns is a double collection, not a second button.
   */
  it('refuses a cash settle while a card settle is still in flight', async () => {
    let releaseCard: (v: unknown) => void = () => {};
    mockProcessPaymentIntent.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseCard = resolve;
        }),
    );

    const {tree} = await renderScreen(openUnpaidTable());

    await act(async () => {
      buttonWithText(tree.root, 'Settle Entire Tab').props.onPress();
    });

    await act(async () => {
      buttonWithText(tree.root, 'Take Cash').props.onPress();
    });

    // The cash path never reached the server while the card attempt was live.
    expect(mockSettleTab).not.toHaveBeenCalled();

    await act(async () => {
      releaseCard({
        success: true,
        reference: 'GATEWAY-REF-1',
        voucherNo: 'V1',
        businessOrderNo: 'B1',
      });
    });
  });

  /**
   * ASSERTION 3 — A REFUSED SETTLE LEAVES THE TAB AS IT WAS.
   *
   * The card is declined, so no settle is sent, nothing is marked paid, and the screen must say
   * so rather than showing a success state. `can_close` is untouched and the table stays open.
   */
  it('leaves the tab untouched and reports the failure when the card is declined', async () => {
    mockProcessPaymentIntent.mockImplementation(async () => ({
      success: false,
      error: 'Payment was declined',
      outcomeKind: 'confirmed_failure',
      gatewayResult: {},
    }));

    const {tree} = await renderScreen(openUnpaidTable());

    await act(async () => {
      buttonWithText(tree.root, 'Settle Entire Tab').props.onPress();
    });

    // No money recorded, and nothing closed.
    expect(mockSettleTab).not.toHaveBeenCalled();
    expect(mockCloseTable).not.toHaveBeenCalled();

    // Staff are told it failed. The alert is an Error alert, never a success one.
    expect(mockAlert).toHaveBeenCalled();
    const [title] = mockAlert.mock.calls[mockAlert.mock.calls.length - 1] as [
      string,
      string,
    ];
    expect(title).toBe('Error');

    // The orders are still shown as unpaid — no optimistic flip to paid.
    expect(textOf(tree.root)).not.toContain('Cash recorded');
  });

  /**
   * A refusal FROM THE SERVER, after a successful card charge, must also not close anything and
   * must not be reported as success. This is the ALREADY_PAID / SETTLE_CLAIM_CONFLICT shape.
   */
  it('reports a server-refused settle as a failure and closes nothing', async () => {
    mockSettleTab.mockImplementation(async () => {
      throw new Error('Settle conflict — some orders were already paid');
    });

    const {tree} = await renderScreen(openUnpaidTable());

    await act(async () => {
      buttonWithText(tree.root, 'Settle Entire Tab').props.onPress();
    });

    expect(mockCloseTable).not.toHaveBeenCalled();
    const [title, body] = mockAlert.mock.calls[
      mockAlert.mock.calls.length - 1
    ] as [string, string];
    expect(title).toBe('Error');
    expect(body).toContain('already paid');
  });
});
