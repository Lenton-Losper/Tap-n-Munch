/**
 * The settle control on the WAITER table view — the screen that had only Add Round.
 *
 * What is asserted here is the control's GATING, not the payment itself: money is taken by
 * TableDetailScreen, and settleDoesNotCloseTable.test.tsx covers that. What this screen must
 * get right is when to offer the control at all, and that it says which of paid / part-paid /
 * closed it is looking at — because a waiter who cannot tell those apart takes the wrong action.
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
import type {TabLinesPayload} from '../../lib/tabLines';

const mockGetTabLines = jest.fn();
const mockGetTablesWithMeta = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    getTabLines: (...args: unknown[]) => mockGetTabLines(...(args as [])),
    getTablesWithMeta: (...args: unknown[]) =>
      mockGetTablesWithMeta(...(args as [])),
  };
});

jest.mock('../../lib/storage', () => ({
  getTerminalToken: jest.fn(async () => 'terminal-token'),
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

import ServiceTableScreen from '../ServiceTableScreen';

const SETTLE_LABEL = 'Take payment';

function linesPayload(): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 9140,
      status: 'open',
      total: 250,
      opened_at: '2026-08-28T08:00:00Z',
      opened_by_user_id: null,
    },
    orders: [],
    summary: {total_lines: 0, outstanding: 0, ready: 0, voided: 0},
    all_ready: false,
    has_lines: false,
    server_time: null,
  };
}

function tableWith(
  tabStatus: string,
  orders: Array<{id: string; payment_status: string}>,
  unpaidTotal: number,
): TableWithTab {
  return {
    id: 'table-9140',
    table_number: 9140,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: tabStatus,
      total: 250,
      unpaid_total: unpaidTotal,
      orders: orders.map((o, i) => ({
        id: o.id,
        order_number: 10 + i,
        total: 125,
        status: 'completed',
        payment_status: o.payment_status,
        items: [],
        placed_at: '2026-08-28T08:00:00Z',
        can_settle_card: o.payment_status === 'unpaid',
        can_settle_cash: o.payment_status === 'unpaid',
      })),
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

async function renderScreen() {
  const navigation = {navigate: jest.fn(), goBack: jest.fn()};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ServiceTableScreen
        route={
          {
            params: {
              tableId: 'table-9140',
              tableNumber: 9140,
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
  return {tree, navigation};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTabLines.mockImplementation(async () => linesPayload());
});

describe('the settle control on the waiter table view', () => {
  it('offers settle alongside Add Round on an unpaid tab', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [tableWith('open', [{id: 'o1', payment_status: 'unpaid'}], 250)],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree} = await renderScreen();
    const screen = textOf(tree.root);

    // Both controls, not one instead of the other.
    expect(screen).toContain(SETTLE_LABEL);
    expect(screen).toContain('Add Round');
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(false);
  });

  it('routes a settle into the screen that actually takes money, carrying the table', async () => {
    const table = tableWith('open', [{id: 'o1', payment_status: 'unpaid'}], 250);
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [table],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree, navigation} = await renderScreen();

    await act(async () => {
      buttonWithText(tree.root, SETTLE_LABEL).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('TableDetail', {table});
  });

  /**
   * DOUBLE-TAP. No money moves here, but two pushes leave a second settle screen stacked under
   * the first, each holding its own copy of the tab — and a waiter backing out of one lands on
   * another that looks live.
   */
  it('opens the settle screen once when double-tapped in a single tick', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [tableWith('open', [{id: 'o1', payment_status: 'unpaid'}], 250)],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree, navigation} = await renderScreen();
    const button = buttonWithText(tree.root, SETTLE_LABEL);

    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
  });

  /**
   * PAID IS NOT CLOSED, as the waiter sees it. A tab paid to the last cent still shows Add
   * Round — the party can keep ordering — and shows a chip that is NOT the closed chip.
   */
  it('shows a fully paid tab as paid-and-open, still offering Add Round', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [tableWith('open', [{id: 'o1', payment_status: 'paid'}], 0)],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree} = await renderScreen();
    const screen = textOf(tree.root);

    expect(screen).toContain('Paid in full · table still open');
    expect(screen).not.toContain('Paid in full · table closed');
    expect(screen).toContain('Add Round');
    // Nothing left to charge, so the control is present but inert.
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(true);
  });

  /**
   * THE DIGI COFEE CASE. Production, 2026-08-28: the stale-payment sweep cancelled orders #30,
   * #31 and #32 (NAD 3 + 5 + 11) minutes after each was placed, paid_at null on all three, the
   * kitchen already cooking. Nothing owed and nothing paid, so the screen said PAID IN FULL.
   *
   * It briefly shared the unpaid chip, which was true but incomplete: a waiter reading 'nothing
   * paid yet' on a cancelled tab tries to take payment for food that has no order behind it.
   * Its own chip now says what actually happened.
   */
  it('says the rounds were cancelled, not that the tab is paid or merely unpaid', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [
        tableWith(
          'open',
          [
            {id: 'o30', payment_status: 'cancelled'},
            {id: 'o31', payment_status: 'cancelled'},
            {id: 'o32', payment_status: 'cancelled'},
          ],
          0,
        ),
      ],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree} = await renderScreen();
    const screen = textOf(tree.root);

    expect(screen).toContain('Nothing to pay · rounds were cancelled');
    // The two readings that cost money: one closes the table, the other charges for nothing.
    expect(screen).not.toContain('Paid in full');
    expect(screen).not.toContain('Nothing paid yet');
    // There is nothing to charge for, so settling must not be offered.
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(true);
  });

  it('distinguishes a partially paid tab from an unpaid one', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [
        tableWith(
          'open',
          [
            {id: 'o1', payment_status: 'paid'},
            {id: 'o2', payment_status: 'unpaid'},
          ],
          125,
        ),
      ],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree} = await renderScreen();
    const screen = textOf(tree.root);

    expect(screen).toContain(
      'Part paid · balance still owed',
    );
    expect(screen).not.toContain('Nothing paid yet · table open');
    // Still settleable — the remainder is still owed and still payable.
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(false);
    // And the figure shown is the server's unpaid_total, not the tab total.
    expect(screen).toContain('NAD 125.00');
  });

  it('shows a closed session as closed and withdraws the settle control', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => ({
      tables: [tableWith('settled', [{id: 'o1', payment_status: 'paid'}], 0)],
      cardInFlightTimeoutSeconds: 120,
    }));

    const {tree} = await renderScreen();

    expect(textOf(tree.root)).toContain('Paid in full · table closed');
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(true);
  });

  /**
   * FAILS CLOSED. When the money payload cannot be read the screen must not imply that nobody
   * has paid — it says the state is unknown and refuses to start a payment it cannot reason
   * about. The bill and the lines are still shown.
   */
  it('withdraws settle and says so when the payment state cannot be read', async () => {
    mockGetTablesWithMeta.mockImplementation(async () => {
      throw new Error('tables unavailable');
    });

    const {tree, navigation} = await renderScreen();
    const screen = textOf(tree.root);

    expect(screen).toContain('Payment status unavailable · do not assume the bill is settled');
    expect(screen).not.toContain('Nothing paid yet · table open');
    expect(buttonWithText(tree.root, SETTLE_LABEL).props.disabled).toBe(true);

    // Even if the press somehow arrives, it must not navigate into a payment.
    await act(async () => {
      buttonWithText(tree.root, SETTLE_LABEL).props.onPress();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();

    // The lines view survives the money failure.
    expect(screen).toContain('NAD 250.00');
  });
});
