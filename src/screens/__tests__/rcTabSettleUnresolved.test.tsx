/**
 * RC SPRINT 2026-09-30 — AN UNCONFIRMED CARD SETTLE ON THE TABLE SCREEN IS NOT A LIVE CARD BUTTON.
 *
 * THE DEFECT. TableDetailScreen's whole-tab / selected-orders card settle, on an UNKNOWN result
 * (9027, a report the server could not confirm, a settle that failed after the reader charged),
 * showed an alert and left "Settle Entire Tab" / "Settle Selected" live. prepare-payment does not
 * refuse while an attempt is unresolved, so the next tap launched a second SALE for orders whose
 * card may already have been charged. The alert told staff to "check the payment status on the
 * order" -- and nothing on either screen offered that check for a tab attempt.
 *
 * THE RULE, the same one PaymentScreen follows (owner D2 spec 2026-09-30): after an unknown result
 * no second payment is offered for those orders, card OR cash, until the server has answered. The
 * action is Check, which calls POST /api/terminal/orders/{leadOrderId}/verify-payment -- the route
 * resolves the whole settlement from the lead order's pending_settlement_id. Paid -> refresh.
 * Still uncertain -> keep Check, signed copy only. The state is persisted per lead order (the same
 * store PaymentScreen uses), so leaving the table or restarting keeps it.
 *
 * HARNESS: the real TableDetailScreen and the real verifyTerminalPayment over a faked fetch; the
 * reader boundary (processPaymentIntent) and the tab/settle reads are mocked as in
 * settleSelectedOrders.test.tsx. AsyncStorage is an in-memory map that survives an unmount.
 */
jest.setTimeout(30000);

import React from 'react';
import {Alert, Text} from 'react-native';
import renderer, {act, ReactTestInstance} from 'react-test-renderer';

import type {TableWithTab} from '../../types';

const mockSettleTab = jest.fn();
const mockGetTablesWithMeta = jest.fn();
const mockCompletePaymentReliably = jest.fn();

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return {
    ...actual,
    settleTab: (...args: unknown[]) => mockSettleTab(...(args as [])),
    closeTable: jest.fn(async () => ({})),
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
  UNCONFIRMED_CHECK_ACTION,
  UNCONFIRMED_NO_CONFIRMATION_YET,
  UNCONFIRMED_SETTLE_INSTRUCTION,
  UNCONFIRMED_TITLE,
} from '../../constants/paymentCopy';

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const disk = new Map<string, string>();
type Verify = {status: number; body: Record<string, unknown>} | 'network-error';
let verifyReplies: Verify[] = [];
let verifyCalls: string[] = [];

const VERIFY_NO_RECORD = {
  status: 200,
  body: {
    ok: true,
    paid: false,
    applied: false,
    outcome: 'left_pending_finatic_uncertain',
    verified: true,
    isE04111: true,
    gatewayCode: 'E04111',
    code: 'payment_not_confirmed',
    source: 'finatic',
    merchantOrderNo: 'FT-TAB-1',
    transactionId: null,
    status: 'no_gateway_record',
  },
};
const VERIFY_PAID = {
  status: 200,
  body: {ok: true, paid: true, applied: true, verified: true, source: 'finatic', merchantOrderNo: 'FT-TAB-1', transactionId: 'TXN-9', status: '2'},
};

beforeAll(() => {
  const async = require('@react-native-async-storage/async-storage').default as Record<string, jest.Mock>;
  async.getItem.mockImplementation(async (k: string) => (disk.has(k) ? (disk.get(k) as string) : null));
  async.setItem.mockImplementation(async (k: string, v: string) => {
    disk.set(k, v);
  });
  async.removeItem.mockImplementation(async (k: string) => {
    disk.delete(k);
  });
});

function twoRoundTab(opts: {paid?: boolean} = {}): TableWithTab {
  const order = (id: string, n: number, total: number) => ({
    id,
    order_number: n,
    total,
    status: 'completed',
    payment_status: opts.paid ? 'paid' : 'unpaid',
    items: [],
    placed_at: '2026-09-30T08:00:00Z',
    can_settle_card: !opts.paid,
    can_settle_cash: !opts.paid,
  });
  return {
    id: 'table-77',
    table_number: 77,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: opts.paid ? 0 : 250,
      unpaid_total: opts.paid ? 0 : 250,
      orders: [order('order-1', 11, 150), order('order-2', 12, 100)],
    },
  } as unknown as TableWithTab;
}

function textOf(node: ReactTestInstance): string {
  const collect = (c: unknown): string =>
    typeof c === 'string' ? c : typeof c === 'number' ? String(c) : Array.isArray(c) ? c.map(collect).join('') : '';
  return node
    .findAllByType(Text)
    .map(t => collect(t.props.children))
    .join(' | ');
}
function pressablesWith(root: ReactTestInstance, label: string) {
  return root
    .findAll(n => typeof n.props?.onPress === 'function' && textOf(n).includes(label), {deep: true})
    .filter(n => typeof n.type !== 'string');
}
async function press(root: ReactTestInstance, label: string) {
  const hits = pressablesWith(root, label);
  if (hits.length === 0) {
    throw new Error(`no pressable "${label}": ${textOf(root)}`);
  }
  await act(async () => {
    await hits[hits.length - 1].props.onPress();
  });
  await flush();
}
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
/** Every control carrying `label` is disabled (and there is at least one). */
function allDisabled(root: ReactTestInstance, label: string): boolean {
  const hits = pressablesWith(root, label);
  return hits.length > 0 && hits.every(n => n.props.disabled === true);
}

async function renderScreen(table: TableWithTab = twoRoundTab()) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TableDetailScreen
        route={{params: {table}, key: 'k', name: 'TableDetail'} as never}
        navigation={{navigate: jest.fn(), goBack: jest.fn()} as never}
      />,
    );
  });
  await flush();
  return tree;
}

const UNCERTAIN_REPORT = {success: false, canClose: false, outcome: 'left_pending_finatic_uncertain'};

beforeEach(() => {
  jest.clearAllMocks();
  disk.clear();
  verifyReplies = [];
  verifyCalls = [];
  mockGetTablesWithMeta.mockImplementation(async () => ({tables: [twoRoundTab()], cardInFlightTimeoutSeconds: 90}));
  // The reader's unknown result: 9027 -> PAYMENT_AMBIGUOUS -> 'ambiguous'.
  mockProcessPaymentIntent.mockImplementation(async () => ({
    success: false,
    outcomeKind: 'ambiguous',
    businessOrderNo: 'FT-TAB-1',
    gatewayResult: '9027',
    error: 'Payment result was not a confirmed success (gateway result=9027)',
  }));
  mockCompletePaymentReliably.mockImplementation(async () => UNCERTAIN_REPORT);
  mockSettleTab.mockImplementation(async () => ({
    success: true,
    payment_reference: 'PAY-1',
    method: 'card',
    new_tab_total: 0,
    tab_total_stale: false,
    can_close: true,
    staff_user_id: null,
  }));
  (globalThis as unknown as {fetch: unknown}).fetch = async (input: string) => {
    const path = new URL(String(input)).pathname;
    verifyCalls.push(path);
    const next = (verifyReplies.length > 1 ? verifyReplies.shift() : verifyReplies[0]) ?? 'network-error';
    if (next === 'network-error') {
      throw new TypeError('Network request failed');
    }
    const text = JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: {get: () => 'application/json'},
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  };
});

describe('an unknown card result on Settle Entire Tab', () => {
  it('MUTATION GUARD (tab-unresolved): card settle is blocked, Check is offered, and a second tap launches nothing', async () => {
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);

    const text = textOf(tree.root);
    expect(text).toContain(UNCONFIRMED_TITLE);
    expect(text).toContain(UNCONFIRMED_SETTLE_INSTRUCTION);
    expect(pressablesWith(tree.root, UNCONFIRMED_CHECK_ACTION).length).toBeGreaterThan(0);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(true);

    // Even a press that reaches the handler (a stale closure, a same-batch tap) charges nothing.
    await act(async () => {
      for (const n of pressablesWith(tree.root, 'Settle Entire Tab')) {
        await n.props.onPress();
      }
    });
    await flush();
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('cash is blocked for those orders too — the card may have taken the money', async () => {
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');
    expect(allDisabled(tree.root, 'Take Cash')).toBe(true);
  });

  it('survives leaving the table and coming back (persisted per lead order)', async () => {
    const first = await renderScreen();
    await press(first.root, 'Settle Entire Tab');
    await act(async () => {
      first.unmount();
    });

    const again = await renderScreen();
    expect(textOf(again.root)).toContain(UNCONFIRMED_TITLE);
    expect(allDisabled(again.root, 'Settle Entire Tab')).toBe(true);
    expect(pressablesWith(again.root, UNCONFIRMED_CHECK_ACTION).length).toBeGreaterThan(0);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('Check calls verify-payment on the LEAD order; still uncertain keeps Check with the signed copy; paid refreshes and releases', async () => {
    verifyReplies = [VERIFY_NO_RECORD, VERIFY_PAID];
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');

    await press(tree.root, UNCONFIRMED_CHECK_ACTION);
    expect(verifyCalls).toEqual(['/api/terminal/orders/order-1/verify-payment']);
    expect(textOf(tree.root)).toContain(UNCONFIRMED_NO_CONFIRMATION_YET);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(true);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);

    const refreshesBefore = mockGetTablesWithMeta.mock.calls.length;
    mockGetTablesWithMeta.mockImplementation(async () => ({tables: [twoRoundTab({paid: true})], cardInFlightTimeoutSeconds: 90}));
    await press(tree.root, UNCONFIRMED_CHECK_ACTION);
    expect(verifyCalls).toHaveLength(2);
    expect(mockGetTablesWithMeta.mock.calls.length).toBeGreaterThan(refreshesBefore);
    expect(textOf(tree.root)).not.toContain(UNCONFIRMED_TITLE);
    expect([...disk.keys()].filter(k => k.includes('order-1'))).toEqual([]);
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('a Check that cannot reach the server leaves everything blocked', async () => {
    verifyReplies = ['network-error'];
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');
    await press(tree.root, UNCONFIRMED_CHECK_ACTION);
    expect(textOf(tree.root)).toContain(UNCONFIRMED_TITLE);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(true);
  });
});

describe('other ways into the unresolved state', () => {
  it('the reader CHARGED and the settle then failed on the network: blocked, not a live card button', async () => {
    mockProcessPaymentIntent.mockImplementation(async () => ({
      success: true,
      reference: 'V-1',
      voucherNo: 'V-1',
      businessOrderNo: 'FT-TAB-1',
    }));
    mockSettleTab.mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');
    expect(textOf(tree.root)).toContain(UNCONFIRMED_TITLE);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(true);
  });

  it('an UNCONFIRMED record left by the Charge screen for one of these orders blocks the table too', async () => {
    disk.set(
      'flashtap_payment_state:order-2',
      JSON.stringify({state: 'PAYMENT_UNCONFIRMED', orderId: 'order-2', amount: 100, error: 'x'}),
    );
    const tree = await renderScreen();
    expect(textOf(tree.root)).toContain(UNCONFIRMED_TITLE);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(true);
  });

  it('CONTROL: a definite decline (attempt released, order still owed) does NOT block — Try again is right', async () => {
    mockCompletePaymentReliably.mockImplementation(async () => ({
      success: true,
      canClose: false,
      outcome: 'attempt_released_order_kept',
    }));
    const tree = await renderScreen();
    await press(tree.root, 'Settle Entire Tab');
    expect(textOf(tree.root)).not.toContain(UNCONFIRMED_TITLE);
    expect(allDisabled(tree.root, 'Settle Entire Tab')).toBe(false);
    await press(tree.root, 'Settle Entire Tab');
    expect(mockProcessPaymentIntent).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: once the server shows the orders paid, the record is cleared on refresh', async () => {
    disk.set(
      'flashtap_payment_state:order-1',
      JSON.stringify({state: 'PAYMENT_UNCONFIRMED', orderId: 'order-1', amount: 250, error: 'x', settlementOrderIds: ['order-1', 'order-2']}),
    );
    mockGetTablesWithMeta.mockImplementation(async () => ({tables: [twoRoundTab({paid: true})], cardInFlightTimeoutSeconds: 90}));
    const tree = await renderScreen(twoRoundTab({paid: true}));
    expect(textOf(tree.root)).not.toContain(UNCONFIRMED_TITLE);
    expect(disk.has('flashtap_payment_state:order-1')).toBe(false);
  });
});
